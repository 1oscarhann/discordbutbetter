//! Desktop shell. It shows a small local page where you enter your server's address, then the
//! window simply loads that server's web app. The remote page gets no access to Tauri's native
//! APIs (no capabilities are granted to it), so a compromised server can't touch your computer
//! beyond what any website could.

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

/// Where Tauri serves the bundled picker page from (differs per platform).
fn local_url(path: &str) -> Url {
    #[cfg(any(windows, target_os = "android"))]
    let base = "http://tauri.localhost/";
    #[cfg(not(any(windows, target_os = "android")))]
    let base = "tauri://localhost/";
    Url::parse(base).and_then(|b| b.join(path)).expect("valid local url")
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let change = MenuItemBuilder::with_id("change-server", "Change server…").build(app)?;
            let reload = MenuItemBuilder::with_id("reload", "Reload").accelerator("CmdOrCtrl+R").build(app)?;
            let app_menu = SubmenuBuilder::new(app, "App")
                .item(&change)
                .item(&reload)
                .separator()
                .quit()
                .build()?;
            let edit = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            let menu = MenuBuilder::new(app).items(&[&app_menu, &edit]).build()?;
            app.set_menu(menu)?;

            let opener = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Haunt")
                .inner_size(1280.0, 820.0)
                .min_inner_size(420.0, 520.0)
                // Links with target=_blank open in the user's normal browser, never inside the app.
                .on_new_window(move |url, _features| {
                    if matches!(url.scheme(), "http" | "https" | "mailto") {
                        let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                    }
                    NewWindowResponse::Deny
                })
                // Keep the window title in sync with the page (the server sets its own name).
                .on_document_title_changed(|window, title| {
                    let _ = window.set_title(&title);
                })
                // Mic, camera and screen capture for the server you chose (the OS may still ask).
                // Location is never needed, so it's always refused.
                .on_permission_request(|webview, kind| {
                    let on_server = webview.url().map(|u| matches!(u.scheme(), "http" | "https")).unwrap_or(false);
                    match kind {
                        PermissionKind::Microphone | PermissionKind::Camera | PermissionKind::DisplayCapture | PermissionKind::Notifications if on_server => {
                            PermissionResponse::Allow
                        }
                        PermissionKind::Geolocation => PermissionResponse::Deny,
                        _ => PermissionResponse::Default,
                    }
                })
                .build()?;

            #[cfg(target_os = "linux")]
            window.with_webview(|wv| {
                use webkit2gtk::{SettingsExt, WebViewExt};
                if let Some(settings) = wv.inner().settings() {
                    settings.set_enable_webrtc(true);
                    settings.set_enable_media_stream(true);
                }
            })?;
            #[cfg(not(target_os = "linux"))]
            let _ = window;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let Some(win) = app.get_webview_window("main") else { return };
            match event.id().as_ref() {
                "change-server" => {
                    let _ = win.navigate(local_url("index.html?change=1"));
                }
                "reload" => {
                    let _ = win.eval("location.reload()");
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the desktop app");
}
