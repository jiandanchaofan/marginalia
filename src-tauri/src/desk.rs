//! Desktop cards live under every other window: they are only seen when the desktop is.

/// Put a card window at the very bottom of the stacking order (above only the desktop itself), without activating it.
#[cfg(windows)]
pub fn to_bottom(win: &tauri::Window) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos};
    if let Ok(h) = win.hwnd() {
        unsafe {
            SetWindowPos(h.0 as _, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}

/// Make the window a tool window: no taskbar button, and "show desktop" does not sweep it away.
#[cfg(windows)]
pub fn tool_window(win: &tauri::Window) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GWL_EXSTYLE, GetWindowLongPtrW, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SetWindowLongPtrW, SetWindowPos, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW};
    if let Ok(h) = win.hwnd() {
        unsafe {
            let hwnd = h.0 as _;
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW as isize) & !(WS_EX_APPWINDOW as isize));
            SetWindowPos(hwnd, std::ptr::null_mut(), 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
        }
    }
}

#[cfg(not(windows))]
pub fn to_bottom(_win: &tauri::Window) {}
#[cfg(not(windows))]
pub fn tool_window(_win: &tauri::Window) {}
