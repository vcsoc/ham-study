use gtk::prelude::*;
use std::{
    cell::RefCell,
    fs,
    path::{Path, PathBuf},
    rc::Rc,
    time::Duration,
};

type Dimensions = (i32, i32);

fn valid((width, height): Dimensions) -> bool {
    (360..=32768).contains(&width) && (500..=32768).contains(&height)
}

fn load(path: &Path) -> Option<Dimensions> {
    let data = fs::read_to_string(path).ok()?;
    let (width, height) = data.trim().split_once(' ')?;
    let size = (width.parse().ok()?, height.parse().ok()?);
    valid(size).then_some(size)
}

fn save(path: &Path, (width, height): Dimensions) -> std::io::Result<()> {
    let directory = path.parent().expect("window size path has a parent");
    fs::create_dir_all(directory)?;
    let temp = directory.join(format!("window-size-{}.tmp", std::process::id()));
    fs::write(&temp, format!("{width} {height}\n"))?;
    fs::rename(temp, path)
}

fn remember(window: &gtk::ApplicationWindow, path: &Path, saved: &RefCell<Option<Dimensions>>) {
    let Some(surface) = window.window() else {
        return;
    };
    // Some Wayland compositors mark ordinary floating windows as maximized/tiled.
    if surface
        .state()
        .intersects(gtk::gdk::WindowState::FULLSCREEN | gtk::gdk::WindowState::ICONIFIED)
    {
        return;
    }
    let size = window.size();
    if valid(size) && *saved.borrow() != Some(size) {
        match save(path, size) {
            Ok(()) => *saved.borrow_mut() = Some(size),
            Err(error) => eprintln!("Could not save Ham Study window size: {error}"),
        }
    }
}

pub fn install(window: &gtk::ApplicationWindow, config_dir: PathBuf) {
    let path = config_dir.join("window-size");
    let previous = load(&path);
    if let Some((width, height)) = previous {
        window.set_default_size(width, height);
    }
    let saved = Rc::new(RefCell::new(previous));
    let pending = Rc::new(RefCell::new(None::<gtk::glib::SourceId>));
    {
        let (path, saved, pending) = (path.clone(), saved.clone(), pending.clone());
        window.connect_configure_event(move |window, _| {
            if let Some(timer) = pending.borrow_mut().take() {
                timer.remove();
            }
            let (window, path, saved, pending) = (
                window.downgrade(),
                path.clone(),
                saved.clone(),
                pending.clone(),
            );
            let timer = gtk::glib::timeout_add_local_once(Duration::from_millis(250), {
                let pending = pending.clone();
                move || {
                    pending.borrow_mut().take();
                    if let Some(window) = window.upgrade() {
                        remember(&window, &path, &saved);
                    }
                }
            });
            *pending.borrow_mut() = Some(timer);
            false
        });
    }
    window.connect_delete_event(move |window, _| {
        if let Some(timer) = pending.borrow_mut().take() {
            timer.remove();
        }
        remember(window, &path, &saved);
        gtk::glib::Propagation::Proceed
    });
}
