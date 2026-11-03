// Keep the native HTTP client's streaming, multipart and cancellation behavior.
// Its explicit proxy is owned by this process and forwards only to Vite's
// private socket. A listener taking over the public port never gets the bytes.
use serde::Deserialize;
use std::{
    io,
    path::{Path, PathBuf},
};
use tokio::{io::copy_bidirectional, net::TcpListener, sync::OnceCell};

#[derive(Deserialize)]
struct Endpoint {
    id: String,
    #[cfg(windows)]
    pid: u32,
}

impl Endpoint {
    fn read(directory: &Path) -> io::Result<Self> {
        let data = std::fs::read(directory.join("preview.json"))?;
        let endpoint: Self = serde_json::from_slice(&data)?;
        if endpoint.id.len() != 36
            || !endpoint
                .id
                .bytes()
                .all(|c| c.is_ascii_hexdigit() || c == b'-')
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid Local endpoint",
            ));
        }
        Ok(endpoint)
    }
}

#[cfg(unix)]
async fn connect(directory: &Path) -> io::Result<tokio::net::UnixStream> {
    use std::os::unix::fs::PermissionsExt;
    if std::fs::metadata(directory)?.permissions().mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "insecure Local directory",
        ));
    }
    let endpoint = Endpoint::read(directory)?;
    tokio::net::UnixStream::connect(directory.join(format!("api-{}.sock", endpoint.id))).await
}

#[cfg(windows)]
async fn connect(directory: &Path) -> io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{Foundation::HANDLE, System::Pipes::GetNamedPipeServerProcessId};
    let endpoint = Endpoint::read(directory)?;
    let pipe = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(format!(r"\\.\pipe\koinote-local-{}", endpoint.id))?;
    let mut pid = 0;
    unsafe { GetNamedPipeServerProcessId(HANDLE(pipe.as_raw_handle()), &mut pid) }
        .map_err(io::Error::other)?;
    if pid != endpoint.pid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Local pipe owner changed",
        ));
    }
    Ok(pipe)
}

pub async fn port() -> Result<u16, String> {
    static PORT: OnceCell<u16> = OnceCell::const_new();
    let directory = super::config_home_directory()?.join(".config/koinote-local");
    #[cfg(debug_assertions)]
    let directory = std::env::var_os("KOINOTE_LOCAL_DEV_IPC")
        .map(PathBuf::from)
        .unwrap_or(directory);
    // Verify readiness before returning a URL, including after a Vite restart.
    connect(&directory).await.map_err(|_| {
        "Koinote Local 未连接到自己的本地服务。请检查 5273 端口冲突并重启本地服务。".to_owned()
    })?;
    let port = PORT
        .get_or_try_init(|| start_proxy(directory))
        .await
        .map_err(|err| err.to_string())?;
    Ok(*port)
}

async fn start_proxy(directory: PathBuf) -> io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            let directory = directory.clone();
            tokio::spawn(async move {
                if let Ok(mut backend) = connect(&directory).await {
                    let _ = copy_bidirectional(&mut client, &mut backend).await;
                }
            });
        }
    });
    Ok(port)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::DirBuilderExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpStream, UnixListener};

    #[test]
    fn proxy_only_forwards_to_the_private_endpoint() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let directory = PathBuf::from(format!("/tmp/koi-ipc-test-{}", std::process::id()));
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&directory)
                .unwrap();
            let id = "01234567-89ab-cdef-0123-456789abcdef";
            let socket = directory.join(format!("api-{id}.sock"));
            let private = UnixListener::bind(&socket).unwrap();
            std::fs::write(
                directory.join("preview.json"),
                format!(r#"{{"id":"{id}"}}"#),
            )
            .unwrap();
            let foreign = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let relay = start_proxy(directory.clone()).await.unwrap();
            let request = format!(
                "GET http://{}/api/test HTTP/1.1\r\nAuthorization: Bearer test-only\r\n\r\n",
                foreign.local_addr().unwrap()
            );
            let send = async {
                let mut client = TcpStream::connect(("127.0.0.1", relay)).await.unwrap();
                client.write_all(request.as_bytes()).await.unwrap();
                client.shutdown().await.unwrap();
            };
            let receive = async {
                let (mut peer, _) = private.accept().await.unwrap();
                let mut bytes = Vec::new();
                peer.read_to_end(&mut bytes).await.unwrap();
                assert_eq!(bytes, request.as_bytes());
            };
            tokio::join!(send, receive);
            drop(private);
            std::fs::remove_dir_all(&directory).unwrap();
            let mut client = TcpStream::connect(("127.0.0.1", relay)).await.unwrap();
            let _ = client.write_all(request.as_bytes()).await;
            let mut byte = [0u8; 1];
            assert!(!matches!(client.read(&mut byte).await, Ok(1)));
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(50), foreign.accept())
                    .await
                    .is_err()
            );
        });
    }
}
