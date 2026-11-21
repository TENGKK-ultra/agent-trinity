use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

/// Opens one of the pet-fish local pages in the user's browser. Only loopback
/// addresses are accepted so this command can never be used as a general
/// "open any URL" bridge.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
  let allowed = url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:");

  if !allowed {
    return Err("only local http pages may be opened".to_string());
  }

  #[cfg(target_os = "windows")]
  {
    std::process::Command::new("cmd")
      .args(["/c", "start", "", &url])
      .spawn()
      .map_err(|error| error.to_string())?;
  }

  Ok(())
}

/// Closing the window is a choice the user makes in the app, not a silent exit:
/// the prompt asks; these two commands carry out the answer.
#[tauri::command]
fn hide_to_tray(window: tauri::Window) -> Result<(), String> {
  window.hide().map_err(|error| error.to_string())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
  app.exit(0);
}

/// The hidden main window says it has painted its first frame; the splash uses
/// that moment to start its finale instead of guessing with a fixed duration.
#[tauri::command]
fn main_ready(app: tauri::AppHandle) {
  if let Some(splash) = app.get_webview_window("splash") {
    let _ = splash.emit("trinity-main-ready", ());
  }
}

/// The splash is a transparent full-screen window. When its animation ends the
/// already-loaded main window is revealed and the splash is closed.
#[tauri::command]
fn finish_splash(app: tauri::AppHandle) {
  if let Some(splash) = app.get_webview_window("splash") {
    let _ = splash.set_always_on_top(false);
  }

  if let Some(main) = app.get_webview_window("main") {
    let _ = main.show();
    let _ = main.set_focus();
  }

  if let Some(splash) = app.get_webview_window("splash") {
    let _ = splash.close();
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // The window may be hidden in the tray, so a second launch from the shortcut
    // must reveal the running copy instead of opening a second Trinity. This
    // plugin has to be registered first.
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      reveal(app);
    }))
    // Requests to Trinity Core go through Rust, which avoids the CORS restrictions
    // a webview fetch would hit against 127.0.0.1. The capability file limits which
    // URLs this may reach.
    .plugin(tauri_plugin_http::init())
    .invoke_handler(tauri::generate_handler![
      open_external_url,
      hide_to_tray,
      quit_app,
      finish_splash,
      main_ready
    ])
    .setup(|app| {
      // The config sets minWidth/minHeight, but on Windows those are not always
      // enforced when a window is resized programmatically, so apply it explicitly.
      if let Some(window) = app.get_webview_window("main") {
        window.set_min_size(Some(tauri::LogicalSize::new(1100.0, 700.0)))?;
      }

      // The tray is what makes "hide instead of quit" recoverable: without it the
      // window would be gone with no way back.
      let show = MenuItem::with_id(app, "show", "打开 Trinity", true, None::<&str>)?;
      let quit = MenuItem::with_id(app, "quit", "退出 Trinity", true, None::<&str>)?;
      let menu = Menu::with_items(app, &[&show, &quit])?;

      if let Some(icon) = app.default_window_icon().cloned() {
        TrayIconBuilder::new()
          .icon(icon)
          .tooltip("Trinity")
          .menu(&menu)
          .show_menu_on_left_click(false)
          .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => reveal(app),
            "quit" => app.exit(0),
            _ => {}
          })
          .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
              button: MouseButton::Left,
              button_state: MouseButtonState::Up,
              ..
            } = event
            {
              reveal(tray.app_handle());
            }
          })
          .build(app)?;
      }

      // The intro is its own transparent window so the balls sit straight on
      // the desktop. The main window stays hidden (and keeps loading) until the
      // splash finishes; a watchdog shows it even if the splash never reports.
      let splash = WebviewWindowBuilder::new(app, "splash", WebviewUrl::App("index.html".into()))
        .title("Trinity")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .fullscreen(true)
        .initialization_script("window.__TRINITY_SPLASH__ = true;")
        .build();

      match splash {
        Ok(_) => {
          let handle = app.handle().clone();

          std::thread::spawn(move || {
            // Safety net only: normally the splash closes itself much sooner.
            std::thread::sleep(std::time::Duration::from_secs(20));

            if let Some(main) = handle.get_webview_window("main") {
              let _ = main.show();
            }
            if let Some(splash) = handle.get_webview_window("splash") {
              let _ = splash.close();
            }
          });
        }
        Err(_) => {
          if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
          }
        }
      }

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    // The close button asks first; the window only goes away when the prompt
    // says so (hide to tray or quit).
    .on_window_event(|window, event| {
      if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == "main" {
          api.prevent_close();
          let _ = window.emit("trinity-close-requested", ());
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}

fn reveal(app: &tauri::AppHandle) {
  if let Some(splash) = app.get_webview_window("splash") {
    let _ = splash.close();
  }

  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
  }
}
