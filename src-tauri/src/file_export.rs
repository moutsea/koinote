use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

const MAX_EXPORT_OUTPUT_BYTES: usize = 512 * 1024 * 1024;

fn validated_export_path_buf(output_path: PathBuf) -> Result<PathBuf, String> {
    if !output_path.is_absolute() {
        return Err("export_path_must_be_absolute".to_string());
    }
    if !output_path.parent().is_some_and(Path::is_dir) {
        return Err("export_parent_directory_missing".to_string());
    }
    Ok(output_path)
}

pub fn save_export_path(output_path: PathBuf, bytes: Vec<u8>) -> Result<(), String> {
    if bytes.len() > MAX_EXPORT_OUTPUT_BYTES {
        return Err("export_output_too_large".to_string());
    }
    validated_export_path_buf(output_path.clone())?;

    let parent = output_path
        .parent()
        .ok_or_else(|| "export_parent_directory_missing".to_string())?;
    let file_name = output_path
        .file_name()
        .ok_or_else(|| "export_path_invalid".to_string())?;
    let mut temporary_path = parent.join(file_name);
    let mut temporary_file = None;
    for attempt in 0..100 {
        let mut temporary_name = file_name.to_os_string();
        temporary_name.push(format!(
            ".koinote-export-{}-{attempt}.tmp",
            std::process::id()
        ));
        temporary_path = parent.join(temporary_name);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
        {
            Ok(file) => {
                temporary_file = Some(file);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    let mut temporary_file = temporary_file.ok_or_else(|| "export_temp_path_busy".to_string())?;
    let write_result = (|| {
        temporary_file
            .write_all(&bytes)
            .map_err(|error| error.to_string())?;
        temporary_file
            .sync_all()
            .map_err(|error| error.to_string())?;
        Ok::<(), String>(())
    })();
    drop(temporary_file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }

    if let Err(error) = replace_file(&temporary_path, &output_path) {
        let _ = fs::remove_file(&temporary_path);
        return Err(error);
    }
    Ok(())
}

fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            },
        };

        let from_wide: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to_wide: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            MoveFileExW(
                PCWSTR(from_wide.as_ptr()),
                PCWSTR(to_wide.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|error| error.to_string())?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::rename(from, to).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_path(filename: &str) -> PathBuf {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "koinote-export-{}-{timestamp}-{filename}",
            std::process::id()
        ))
    }

    #[test]
    fn export_path_requires_absolute_existing_parent() {
        assert_eq!(
            validated_export_path_buf(PathBuf::from("note.html")).unwrap_err(),
            "export_path_must_be_absolute"
        );
        let missing_parent = test_path("missing-parent").join("note.html");
        assert_eq!(
            validated_export_path_buf(missing_parent).unwrap_err(),
            "export_parent_directory_missing"
        );
    }

    #[test]
    fn save_export_writes_bytes() {
        let path = test_path("测试.docx");
        let bytes = vec![0x50, 0x4b, 0x03, 0x04, 0, 0xff, 0x80];
        save_export_path(path.clone(), bytes.clone()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        save_export_path(path.clone(), b"short".to_vec()).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"short");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn failed_write_does_not_truncate_existing_file() {
        let path = test_path("existing.html");
        let original = b"original content".to_vec();
        save_export_path(path.clone(), original.clone()).unwrap();
        let result = save_export_path(path.clone(), vec![0; MAX_EXPORT_OUTPUT_BYTES + 1]);
        assert_eq!(result.unwrap_err(), "export_output_too_large");
        assert_eq!(std::fs::read(&path).unwrap(), original);
        std::fs::remove_file(path).unwrap();
    }
}
