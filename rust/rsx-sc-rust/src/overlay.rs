//! `select` 子命令 — 原生全屏框选蒙版（从 tauri2 的 capture_window.rs 移植）。
//!
//! 流程：截取光标所在显示器的整屏快照 → 建一个无边框、置顶、全屏的窗口，
//! 先画好「压暗的快照」再显示（无白闪）→ 用户拖拽画框（框内还原原始像素、
//! 蓝色边框、四角绿色 L 形标记表示「该区域将被循环截屏」）→ 松开鼠标输出
//! 选中矩形的显示器相对坐标 → 进程退出。
//!
//! 交互（与 tauri2 及所有主流截屏工具一致）：
//!   * 左键拖拽   选中
//!   * Esc / 右键 取消
//!   * 触摸/数位笔 Windows 上走 WM_POINTER，同样支持拖拽
//!
//! 与 tauri2 的结构差异：tauri2 是常驻 GUI 应用，winit 每进程只允许一个
//! EventLoop，所以它用常驻后台线程 + `EventLoopProxy` 派发 StartCapture。
//! 本二进制每次 `select` 都是一个新进程，事件循环可以直接归主线程所有，
//! 于是那套 proxy 单例被整个删掉——快照在进事件循环之前截好，窗口在
//! `resumed()` 里打开，结果通过 mpsc 带出来。
//!
//! 输出协议（stdout，单行 JSON）：
//!   选中   {"ok":true,"x":..,"y":..,"width":..,"height":..,"monitorIndex":N,
//!           "monitor":{"x":..,"y":..,"width":..,"height":..,"scaleFactor":..}}
//!   取消   {"ok":true,"cancelled":true}
//!   出错   stderr 文本 + 退出码 1（由 main 统一打印）

use std::num::NonZeroU32;
use std::sync::mpsc;

use softbuffer::{Context, Surface};
use winit::application::ApplicationHandler;
use winit::dpi::PhysicalPosition;
use winit::event::{ElementState, MouseButton, TouchPhase, WindowEvent};
use winit::event_loop::{ActiveEventLoop, EventLoop};
use winit::window::{Fullscreen, Window, WindowLevel};

use crate::core::screenshot::capture::{
    capture_screen_rgba, find_cursor_monitor_indexed,
};
use crate::error::AppResult;

// ── Loop-mode corner marker tunables（与 tauri2 相同）────────────────────────
//
// 绿色 L 形四角标记：告诉用户「这个区域会被循环截屏」。在 rsx-sc 里每一次
// 框选都是为了 loop_capture，所以标记恒定绘制（tauri2 里是 AutoLoop 才画）。
const LOOP_MARKER_COLOR: u32 = 0x0026C13E; // saturated green (Win11 screenshot feel)
const LOOP_MARKER_ARM: u32 = 24; // arm length in px
const LOOP_MARKER_THICKNESS: u32 = 4; // line width in px
const SELECTION_BORDER_COLOR: u32 = 0x004A9EFF; // blue border

/// 选中矩形，显示器相对物理像素坐标（与 `loop_capture` 的 region 同一坐标系）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct Selection {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    pub monitor_index: usize,
}

enum OverlayEvent {
    Selected(Selection),
    Cancelled,
}

/// 子进程入口：`rsx-sc-rust select`。
pub async fn run() -> AppResult<()> {
    // 1. 先截快照（阻塞调用，丢进 blocking 线程），再进事件循环。
    //    block_on 跑在主线程上，因此 winit 在 macOS 上也满足「主线程」约束。
    let (rgba, img_w, img_h, monitor, monitor_index) =
        tokio::task::spawn_blocking(|| -> AppResult<_> {
            let (mon, idx) = find_cursor_monitor_indexed()?;
            let (rgba, w, h) = capture_screen_rgba(&mon)?;
            Ok((rgba, w, h, mon.monitor, idx))
        })
        .await
        .map_err(|e| crate::error::AppError::Capture(format!("capture join error: {e}")))??;

    // 2. 事件循环。结果经 mpsc 带出。
    let (tx, rx) = mpsc::channel::<OverlayEvent>();

    #[cfg(target_os = "windows")]
    unsafe {
        extern "system" {
            fn EnableMouseInPointer(fEnable: i32) -> i32;
        }
        // Windows Ink / 部分数位板驱动把笔事件路由到 WM_MOUSExxx；
        // 不开这个，那些笔永远到不了蒙版窗口。
        let _ = EnableMouseInPointer(1); // TRUE
    }

    #[cfg(target_os = "windows")]
    let event_loop = {
        use winit::platform::windows::EventLoopBuilderExtWindows;
        EventLoop::<()>::with_user_event()
            .with_any_thread(true)
            .build()
            .expect("failed to build winit event loop")
    };
    #[cfg(not(target_os = "windows"))]
    let event_loop = EventLoop::<()>::with_user_event()
        .build()
        .expect("failed to build winit event loop");

    let mut app = SelectApp {
        start: Some(StartParams {
            rgba,
            img_w,
            img_h,
            monitor_x: monitor.x,
            monitor_y: monitor.y,
            monitor_index,
        }),
        session: None,
        _ctx_storage: None,
        result_tx: tx,
    };
    let _ = event_loop.run_app(&mut app);

    // 3. 汇报结果。
    match rx.try_recv() {
        Ok(OverlayEvent::Selected(sel)) => {
            println!(
                "{}",
                serde_json::json!({
                    "ok": true,
                    "x": sel.x,
                    "y": sel.y,
                    "width": sel.width,
                    "height": sel.height,
                    "monitorIndex": sel.monitor_index,
                })
            );
        }
        Ok(OverlayEvent::Cancelled) => {
            println!("{}", serde_json::json!({ "ok": true, "cancelled": true }));
        }
        Err(_) => {
            // 事件循环退出但没发结果（如窗口系统直接杀掉）→ 视为取消。
            println!(
                "{}",
                serde_json::json!({ "ok": true, "cancelled": true, "reason": "no-selection-event" })
            );
        }
    }
    Ok(())
}

// ── Event-loop glue ──────────────────────────────────────────────────────────

struct StartParams {
    rgba: Vec<u8>,
    img_w: u32,
    img_h: u32,
    monitor_x: i32,
    monitor_y: i32,
    monitor_index: usize,
}

struct CaptureSession {
    img_w: u32,
    img_h: u32,
    original_pixels: Vec<u32>,
    darkened_pixels: Vec<u32>,
    window: std::sync::Arc<Window>,
    surface: Surface<std::sync::Arc<Window>, std::sync::Arc<Window>>,
    drag_start: Option<PhysicalPosition<f64>>,
    selection: Option<(u32, u32, u32, u32)>,
    is_dragging: bool,
    mouse_pos: PhysicalPosition<f64>,
    surface_ready: bool,
    shown: bool,
}

struct SelectApp {
    start: Option<StartParams>,
    session: Option<CaptureSession>,
    // softbuffer 的 Context 必须活到 Surface 之后，单放一份保命。
    _ctx_storage: Option<Context<std::sync::Arc<Window>>>,
    result_tx: mpsc::Sender<OverlayEvent>,
}

impl SelectApp {
    fn open_window(&mut self, event_loop: &ActiveEventLoop, p: StartParams) {
        // 按显示器坐标找到对应的物理显示器，全屏到那一块。
        let target_monitor = event_loop
            .available_monitors()
            .find(|m| m.position().x == p.monitor_x && m.position().y == p.monitor_y);
        let fullscreen = match target_monitor {
            Some(m) => Fullscreen::Borderless(Some(m)),
            None => Fullscreen::Borderless(None),
        };

        let attrs = Window::default_attributes()
            .with_title("rsx-sc select")
            .with_decorations(false)
            .with_resizable(false)
            .with_fullscreen(Some(fullscreen))
            .with_window_level(WindowLevel::AlwaysOnTop)
            .with_visible(false);

        let window = match event_loop.create_window(attrs) {
            Ok(w) => std::sync::Arc::new(w),
            Err(e) => {
                eprintln!("failed to create select window: {e}");
                let _ = self.result_tx.send(OverlayEvent::Cancelled);
                event_loop.exit();
                return;
            }
        };

        let ctx = Context::new(window.clone()).expect("softbuffer context");
        let surface = Surface::new(&ctx, window.clone()).expect("softbuffer surface");

        let original_pixels = rgba_to_softbuffer(&p.rgba);
        let darkened_pixels = darken_pixels(&original_pixels, 0.55);

        self._ctx_storage = Some(ctx);
        let mut session = CaptureSession {
            img_w: p.img_w,
            img_h: p.img_h,
            original_pixels,
            darkened_pixels,
            window,
            surface,
            drag_start: None,
            selection: None,
            is_dragging: false,
            mouse_pos: PhysicalPosition::new(0.0, 0.0),
            surface_ready: false,
            shown: false,
        };

        // 显示窗口之前先画好第一帧，用户永远看不到白屏闪烁。
        if let (Some(nz_w), Some(nz_h)) = (NonZeroU32::new(p.img_w), NonZeroU32::new(p.img_h)) {
            if session.surface.resize(nz_w, nz_h).is_ok() {
                session.surface_ready = true;
                if let Ok(mut buffer) = session.surface.buffer_mut() {
                    if buffer.len() == (p.img_w * p.img_h) as usize {
                        buffer.copy_from_slice(&session.darkened_pixels);
                        let _ = buffer.present();
                        session.shown = true;
                        session.window.set_visible(true);
                    }
                }
            }
        }

        self.session = Some(session);
    }

    fn close_window(&mut self) {
        // 丢掉 session 即释放 Arc<Window> → 窗口自动关闭。
        self.session = None;
        self._ctx_storage = None;
    }

    fn finish(&mut self, event_loop: &ActiveEventLoop, ev: OverlayEvent) {
        let _ = self.result_tx.send(ev);
        self.close_window();
        event_loop.exit();
    }

    /// 开始拖拽。鼠标与数位笔两个入口共用。
    fn handle_drag_press(&mut self) {
        if let Some(session) = &mut self.session {
            session.drag_start = Some(session.mouse_pos);
            session.is_dragging = true;
            session.selection = None;
        }
    }

    /// 结束拖拽。真正拖出了矩形（>4px）就算选中；否则视为取消——
    /// 单次轻点不该把用户困在蒙版里。
    fn handle_drag_release(&mut self, event_loop: &ActiveEventLoop) {
        let selection = if let Some(session) = &mut self.session {
            if session.is_dragging {
                if let Some(start) = session.drag_start {
                    session.selection = Some(normalize_rect(start, session.mouse_pos));
                }
                session.is_dragging = false;
                session.drag_start = None;
                session
                    .selection
                    .filter(|(_, _, w, h)| *w > 4 && *h > 4)
            } else {
                None
            }
        } else {
            None
        };

        match selection {
            Some((x, y, w, h)) => {
                let monitor_index = self
                    .start
                    .as_ref()
                    .map(|p| p.monitor_index)
                    .unwrap_or(0);
                self.finish(
                    event_loop,
                    OverlayEvent::Selected(Selection { x, y, width: w, height: h, monitor_index }),
                );
            }
            None => self.finish(event_loop, OverlayEvent::Cancelled),
        }
    }

    fn handle_pen_move(&mut self, position: PhysicalPosition<f64>) {
        if let Some(session) = &mut self.session {
            session.mouse_pos = position;
            if session.is_dragging {
                session.window.request_redraw();
            }
        }
    }

    fn handle_cancel(&mut self, event_loop: &ActiveEventLoop) {
        self.finish(event_loop, OverlayEvent::Cancelled);
    }
}

impl ApplicationHandler<()> for SelectApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if let Some(p) = self.start.take() {
            self.open_window(event_loop, p);
        }
    }

    fn window_event(
        &mut self,
        event_loop: &ActiveEventLoop,
        _window_id: winit::window::WindowId,
        event: WindowEvent,
    ) {
        match event {
            WindowEvent::Resized(size) => {
                if let Some(session) = &mut self.session {
                    if size.width > 0 && size.height > 0 {
                        let _ = session.surface.resize(
                            NonZeroU32::new(size.width).unwrap(),
                            NonZeroU32::new(size.height).unwrap(),
                        );
                        session.surface_ready = true;
                        session.window.request_redraw();
                    }
                }
            }

            WindowEvent::RedrawRequested => {
                if let Some(session) = &mut self.session {
                    redraw_session(session);
                }
            }

            WindowEvent::KeyboardInput { event: key_event, .. } => {
                use winit::keyboard::{KeyCode, PhysicalKey};
                if key_event.state == ElementState::Pressed {
                    if let PhysicalKey::Code(KeyCode::Escape) = key_event.physical_key {
                        self.handle_cancel(event_loop);
                    }
                }
            }

            WindowEvent::MouseInput {
                state,
                button: MouseButton::Left,
                ..
            } => match state {
                ElementState::Pressed => self.handle_drag_press(),
                ElementState::Released => self.handle_drag_release(event_loop),
            },

            WindowEvent::CursorMoved { position, .. } => {
                self.handle_pen_move(position);
            }

            // 右键取消——所有截屏工具的通行约定。
            WindowEvent::MouseInput {
                state: ElementState::Pressed,
                button: MouseButton::Right,
                ..
            } => self.handle_cancel(event_loop),

            // 笔 / 数位板 / 触摸。Windows 上 winit 0.30 走 WM_POINTER 路径，
            // 以 WindowEvent::Touch 而非 MouseInput 送达；少了这个分支，
            // 触控笔点上去蒙版毫无反应。
            WindowEvent::Touch(touch) => match touch.phase {
                TouchPhase::Started => {
                    self.handle_pen_move(touch.location);
                    self.handle_drag_press();
                }
                TouchPhase::Moved => {
                    self.handle_pen_move(touch.location);
                }
                TouchPhase::Ended => {
                    self.handle_pen_move(touch.location);
                    self.handle_drag_release(event_loop);
                }
                TouchPhase::Cancelled => self.handle_cancel(event_loop),
            },

            WindowEvent::CloseRequested => self.handle_cancel(event_loop),

            _ => {}
        }
    }
}

// ── Per-frame rendering（与 tauri2 逐行一致，loop_mode 恒为 true）────────────

fn redraw_session(session: &mut CaptureSession) {
    if !session.surface_ready {
        return;
    }

    let mut buffer = match session.surface.buffer_mut() {
        Ok(b) => b,
        Err(_) => return,
    };

    let expected = (session.img_w * session.img_h) as usize;
    if buffer.len() != expected {
        buffer.fill(0);
        let _ = buffer.present();
        return;
    }

    // 1. 底图：压暗的全屏快照。
    buffer.copy_from_slice(&session.darkened_pixels);

    // 2. 拖拽中的矩形内部还原原始像素。
    let sel = if session.is_dragging {
        session.drag_start.map(|s| normalize_rect(s, session.mouse_pos))
    } else {
        session.selection
    };

    if let Some((sx, sy, sw, sh)) = sel {
        if sw > 0 && sh > 0 {
            blit_pixels(
                &mut buffer,
                session.img_w,
                &session.original_pixels,
                session.img_w,
                sx,
                sy,
                sx,
                sy,
                sw,
                sh,
            );
            // 3. 蓝色边框。
            draw_border(&mut buffer, session.img_w, session.img_h, sx, sy, sw, sh, SELECTION_BORDER_COLOR, 2);
            // 4. 四角绿色 L 形标记（循环截屏提示，恒定绘制）。
            draw_corner_markers(
                &mut buffer,
                session.img_w,
                session.img_h,
                sx,
                sy,
                sw,
                sh,
                LOOP_MARKER_COLOR,
                LOOP_MARKER_ARM,
                LOOP_MARKER_THICKNESS,
            );
        }
    }

    let _ = buffer.present();

    if !session.shown {
        session.shown = true;
        session.window.set_visible(true);
    }
}

// ── Pixel helpers（与 tauri2 逐行一致）───────────────────────────────────────

fn rgba_to_softbuffer(rgba: &[u8]) -> Vec<u32> {
    rgba.chunks_exact(4)
        .map(|px| ((px[0] as u32) << 16) | ((px[1] as u32) << 8) | (px[2] as u32))
        .collect()
}

fn darken_pixels(pixels: &[u32], factor: f32) -> Vec<u32> {
    pixels
        .iter()
        .map(|&p| {
            let r = (((p >> 16) & 0xFF) as f32 * factor) as u32;
            let g = (((p >> 8) & 0xFF) as f32 * factor) as u32;
            let b = ((p & 0xFF) as f32 * factor) as u32;
            (r << 16) | (g << 8) | b
        })
        .collect()
}

/// Copy a `w×h` rectangle from `src` into `dst` at `(dx, dy)`.
fn blit_pixels(
    dst: &mut [u32],
    dst_w: u32,
    src: &[u32],
    src_stride: u32,
    src_ox: u32,
    src_oy: u32,
    dx: u32,
    dy: u32,
    w: u32,
    h: u32,
) {
    let dst_w = dst_w as usize;
    let src_stride = src_stride as usize;
    let len = w as usize;
    for row in 0..(h as usize) {
        let dst_start = (dy as usize + row) * dst_w + dx as usize;
        let src_start = (src_oy as usize + row) * src_stride + src_ox as usize;
        if dst_start + len <= dst.len() && src_start + len <= src.len() {
            dst[dst_start..dst_start + len].copy_from_slice(&src[src_start..src_start + len]);
        }
    }
}

fn draw_border(
    buf: &mut [u32],
    buf_w: u32,
    buf_h: u32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    color: u32,
    thickness: u32,
) {
    let bw = buf_w as usize;
    let x2 = (x + w).min(buf_w);
    let y2 = (y + h).min(buf_h);
    for t in 0..thickness {
        let top = (y + t) as usize;
        let bot = y2.saturating_sub(1).saturating_sub(t) as usize;
        for col in x..x2 {
            let c = col as usize;
            if top < buf_h as usize {
                let i = top * bw + c;
                if i < buf.len() {
                    buf[i] = color;
                }
            }
            if bot != top && bot < buf_h as usize {
                let i = bot * bw + c;
                if i < buf.len() {
                    buf[i] = color;
                }
            }
        }
        let left = (x + t) as usize;
        let right = x2.saturating_sub(1).saturating_sub(t) as usize;
        for row in y..y2 {
            let r = row as usize;
            if r < buf_h as usize {
                let li = r * bw + left;
                if li < buf.len() {
                    buf[li] = color;
                }
                if right != left {
                    let ri = r * bw + right;
                    if ri < buf.len() {
                        buf[ri] = color;
                    }
                }
            }
        }
    }
}

fn normalize_rect(a: PhysicalPosition<f64>, b: PhysicalPosition<f64>) -> (u32, u32, u32, u32) {
    let x1 = a.x.min(b.x).max(0.0) as u32;
    let y1 = a.y.min(b.y).max(0.0) as u32;
    let x2 = a.x.max(b.x).max(0.0) as u32;
    let y2 = a.y.max(b.y).max(0.0) as u32;
    (x1, y1, x2.saturating_sub(x1), y2.saturating_sub(y1))
}

/// Paint a solid `w × h` rectangle at `(x, y)`, clipped to buffer bounds.
fn fill_rect(
    buf: &mut [u32],
    buf_w: u32,
    buf_h: u32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    color: u32,
) {
    let bw = buf_w as usize;
    let x2 = x.saturating_add(w).min(buf_w);
    let y2 = y.saturating_add(h).min(buf_h);
    for row in y..y2 {
        let r = row as usize;
        let row_start = r * bw;
        for col in x..x2 {
            let i = row_start + col as usize;
            if i < buf.len() {
                buf[i] = color;
            }
        }
    }
}

/// 四角绿色 L 形标记——「边框 + 角托」的视觉。
fn draw_corner_markers(
    buf: &mut [u32],
    buf_w: u32,
    buf_h: u32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
    color: u32,
    arm: u32,
    thickness: u32,
) {
    let arm = arm.min(w).min(h).max(thickness);
    let x2 = x.saturating_add(w);
    let y2 = y.saturating_add(h);

    // Top-left
    fill_rect(buf, buf_w, buf_h, x, y, arm, thickness, color);
    fill_rect(buf, buf_w, buf_h, x, y, thickness, arm, color);
    // Top-right
    fill_rect(buf, buf_w, buf_h, x2.saturating_sub(arm), y, arm, thickness, color);
    fill_rect(buf, buf_w, buf_h, x2.saturating_sub(thickness), y, thickness, arm, color);
    // Bottom-left
    fill_rect(buf, buf_w, buf_h, x, y2.saturating_sub(thickness), arm, thickness, color);
    fill_rect(buf, buf_w, buf_h, x, y2.saturating_sub(arm), thickness, arm, color);
    // Bottom-right
    fill_rect(buf, buf_w, buf_h, x2.saturating_sub(arm), y2.saturating_sub(thickness), arm, thickness, color);
    fill_rect(buf, buf_w, buf_h, x2.saturating_sub(thickness), y2.saturating_sub(arm), thickness, arm, color);
}