use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use tauri::WebviewWindow;

const MAX_PDF_OUTPUT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_PDF_EXPORT_DURATION: Duration = Duration::from_secs(30);
const PDF_COMPLETION_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, PartialEq, Eq)]
enum PdfOutputState {
    Pending,
    Complete,
}

fn validated_pdf_path(path: String) -> Result<PathBuf, String> {
    let output_path = PathBuf::from(path);
    if !output_path.is_absolute() {
        return Err("pdf_path_must_be_absolute".to_string());
    }
    if !output_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
    {
        return Err("pdf_path_must_end_with_pdf".to_string());
    }
    if !output_path.parent().is_some_and(Path::is_dir) {
        return Err("pdf_parent_directory_missing".to_string());
    }
    Ok(output_path)
}

fn inspect_pdf_file(path: &Path) -> Result<PdfOutputState, String> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PdfOutputState::Pending)
        }
        Err(error) => return Err(error.to_string()),
    };
    let output_bytes = file.metadata().map_err(|error| error.to_string())?.len();
    if output_bytes > MAX_PDF_OUTPUT_BYTES {
        return Err("pdf_output_too_large".to_string());
    }
    if output_bytes < 5 {
        return Ok(PdfOutputState::Pending);
    }
    let mut header = [0_u8; 5];
    file.read_exact(&mut header)
        .map_err(|error| error.to_string())?;
    if &header != b"%PDF-" {
        return Err("pdf_output_invalid".to_string());
    }

    let tail_bytes = output_bytes.min(2048) as usize;
    file.seek(SeekFrom::End(-(tail_bytes as i64)))
        .map_err(|error| error.to_string())?;
    let mut tail = vec![0_u8; tail_bytes];
    file.read_exact(&mut tail)
        .map_err(|error| error.to_string())?;
    if tail.windows(5).any(|window| window == b"%%EOF") {
        Ok(PdfOutputState::Complete)
    } else {
        Ok(PdfOutputState::Pending)
    }
}

async fn wait_for_pdf_file(path: &Path) -> Result<(), String> {
    let started_at = Instant::now();
    loop {
        match inspect_pdf_file(path) {
            Ok(PdfOutputState::Complete) => return Ok(()),
            Ok(PdfOutputState::Pending) => {}
            Err(error) => {
                let _ = fs::remove_file(path);
                return Err(error);
            }
        }
        if started_at.elapsed() > MAX_PDF_EXPORT_DURATION {
            let _ = fs::remove_file(path);
            return Err("pdf_export_timed_out".to_string());
        }
        tokio::time::sleep(PDF_COMPLETION_POLL_INTERVAL).await;
    }
}

pub async fn export_pdf(window: WebviewWindow, path: String) -> Result<(), String> {
    let output_path = validated_pdf_path(path)?;
    if output_path.exists() {
        fs::remove_file(&output_path).map_err(|error| error.to_string())?;
    }
    let platform_path = output_path.clone();
    let (sender, mut receiver) = tauri::async_runtime::channel(1);

    window
        .with_webview(move |webview| {
            let result = export_platform_pdf(webview, &platform_path);
            let _ = sender.blocking_send(result);
        })
        .map_err(|error| error.to_string())?;

    let export_result = receiver
        .recv()
        .await
        .ok_or_else(|| "pdf_export_channel_closed".to_string())?;
    if let Err(error) = export_result {
        let _ = fs::remove_file(&output_path);
        return Err(error);
    }
    wait_for_pdf_file(&output_path).await
}

#[cfg(target_os = "macos")]
fn export_platform_pdf(
    platform_webview: tauri::webview::PlatformWebview,
    path: &Path,
) -> Result<(), String> {
    use objc2_app_kit::{
        NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob, NSPrintingPaginationMode,
    };
    use objc2_foundation::{NSCopying, NSSize, NSString, NSURL};
    use objc2_web_kit::WKWebView;

    let path = path
        .to_str()
        .ok_or_else(|| "pdf_path_invalid_unicode".to_string())?;

    unsafe {
        let webview = &*(platform_webview.inner() as *mut WKWebView);
        let print_info = NSPrintInfo::sharedPrintInfo().copy();
        print_info.setPaperSize(NSSize::new(595.28, 841.89));
        print_info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
        print_info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
        print_info.setTopMargin(0.0);
        print_info.setRightMargin(0.0);
        print_info.setBottomMargin(0.0);
        print_info.setLeftMargin(0.0);
        print_info.setJobDisposition(NSPrintSaveJob);

        let file_url = NSURL::fileURLWithPath(&NSString::from_str(path));
        print_info
            .dictionary()
            .insert(NSPrintJobSavingURL, &file_url);

        let operation = webview.printOperationWithPrintInfo(&print_info);
        operation.setShowsPrintPanel(false);
        operation.setShowsProgressPanel(false);
        operation.setCanSpawnSeparateThread(true);
        let document_window = webview
            .window()
            .ok_or_else(|| "pdf_export_window_missing".to_string())?;
        operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            &document_window,
            None,
            None,
            std::ptr::null_mut(),
        );
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn export_platform_pdf(
    platform_webview: tauri::webview::PlatformWebview,
    path: &Path,
) -> Result<(), String> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Environment6, ICoreWebView2PrintSettings, ICoreWebView2_7,
        },
        PrintToPdfCompletedHandler,
    };
    use windows::core::{Error, Interface, HRESULT, HSTRING};

    let controller = platform_webview.controller();
    let environment = platform_webview.environment();
    let output_path = HSTRING::from(path.as_os_str());

    let result = unsafe {
        let webview = controller
            .CoreWebView2()
            .map_err(|error| error.to_string())?;
        let webview: ICoreWebView2_7 = webview.cast().map_err(|error| error.to_string())?;
        let environment: ICoreWebView2Environment6 =
            environment.cast().map_err(|error| error.to_string())?;
        let settings: ICoreWebView2PrintSettings = environment
            .CreatePrintSettings()
            .map_err(|error| error.to_string())?;
        settings
            .SetShouldPrintBackgrounds(true)
            .map_err(|error| error.to_string())?;
        settings
            .SetShouldPrintHeaderAndFooter(false)
            .map_err(|error| error.to_string())?;
        settings
            .SetMarginTop(0.0)
            .map_err(|error| error.to_string())?;
        settings
            .SetMarginRight(0.0)
            .map_err(|error| error.to_string())?;
        settings
            .SetMarginBottom(0.0)
            .map_err(|error| error.to_string())?;
        settings
            .SetMarginLeft(0.0)
            .map_err(|error| error.to_string())?;

        PrintToPdfCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| {
                webview
                    .PrintToPdf(&output_path, &settings, &handler)
                    .map_err(Into::into)
            }),
            Box::new(|operation_result, succeeded| {
                operation_result?;
                if succeeded {
                    Ok(())
                } else {
                    Err(Error::from_hresult(HRESULT(0x80004005_u32 as i32)))
                }
            }),
        )
    };

    result.map_err(|error| error.to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn export_platform_pdf(
    _platform_webview: tauri::webview::PlatformWebview,
    _path: &Path,
) -> Result<(), String> {
    Err("pdf_export_unsupported_platform".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_path_requires_absolute_pdf_path() {
        assert_eq!(
            validated_pdf_path("note.pdf".to_string()).unwrap_err(),
            "pdf_path_must_be_absolute"
        );
        let non_pdf = std::env::temp_dir().join("note.txt");
        assert_eq!(
            validated_pdf_path(non_pdf.to_string_lossy().into_owned()).unwrap_err(),
            "pdf_path_must_end_with_pdf"
        );
    }

    #[test]
    fn pdf_path_accepts_existing_parent_and_case_insensitive_extension() {
        let path = std::env::temp_dir().join("Koinote.PDF");
        assert_eq!(
            validated_pdf_path(path.to_string_lossy().into_owned()).unwrap(),
            path
        );
    }

    #[test]
    fn pdf_verifier_rejects_oversized_output() {
        let path = std::env::temp_dir().join("koinote-oversized-pdf.pdf");
        let file = File::create(&path).unwrap();
        file.set_len(MAX_PDF_OUTPUT_BYTES + 1).unwrap();
        drop(file);

        assert_eq!(inspect_pdf_file(&path).unwrap_err(), "pdf_output_too_large");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn pdf_inspector_waits_for_eof_marker() {
        let path = std::env::temp_dir().join("koinote-incomplete-pdf.pdf");
        fs::write(&path, b"%PDF-1.7\nbody without trailer").unwrap();
        assert_eq!(inspect_pdf_file(&path).unwrap(), PdfOutputState::Pending);

        fs::write(&path, b"%PDF-1.7\nbody\n%%EOF\n").unwrap();
        assert_eq!(inspect_pdf_file(&path).unwrap(), PdfOutputState::Complete);
        fs::remove_file(path).unwrap();
    }
}
