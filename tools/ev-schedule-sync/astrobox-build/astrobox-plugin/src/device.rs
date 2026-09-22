// 设备目标管理 —— DESIGN.md §1 / §2
//
// 宿主提供的能力：
//   astrobox::psys_host::device::get_device_list()          -> Vec<DeviceInfo>  （全部已配对设备）
//   astrobox::psys_host::device::get_connected_device_list()-> Vec<DeviceInfo>  （当前在线）
//   thirdpartyapp::get_thirdparty_app_list(addr)            -> Result<Vec<AppInfo>, ()>
//
// 注意：WIT 里并没有 thirdpartyapp::is_installed 这种直接查询函数（DESIGN.md §7 写的是伪代码），
// 所以「EV 课程表是否已安装」只能通过拉取该设备的应用列表自行匹配得到。

use crate::astrobox::psys_host::{device, thirdpartyapp};

/// EV 课程表在当前设备上的安装状态
#[derive(Clone, Debug, PartialEq)]
pub enum EvInstallStatus {
    /// 已安装，可以同步
    Installed,
    /// 已连接但没装，需要引导安装
    NotInstalled,
    /// 无法判定（设备离线，或应用列表拉取失败）
    Unknown,
    /// 正在检测（UI 轮询期间显示）
    Checking,
}

impl EvInstallStatus {
    pub fn icon(&self) -> &'static str {
        match self {
            EvInstallStatus::Installed => "已安装",
            EvInstallStatus::NotInstalled => "未安装",
            EvInstallStatus::Unknown => "未知",
            EvInstallStatus::Checking => "检测中",
        }
    }

    pub fn color(&self) -> &'static str {
        match self {
            EvInstallStatus::Installed => "#4CAF50",
            EvInstallStatus::NotInstalled => "#F44336",
            EvInstallStatus::Unknown => "#888888",
            EvInstallStatus::Checking => "#FFC107",
        }
    }
}

#[derive(Clone, Debug)]
pub struct DeviceEntry {
    pub name: String,
    pub addr: String,
    pub connected: bool,
    pub ev_status: EvInstallStatus,
}

impl DeviceEntry {
    /// DESIGN.md §2.1：只有「已连接 + EV 已安装」的设备才允许同步
    pub fn is_ready(&self) -> bool {
        self.connected && self.ev_status == EvInstallStatus::Installed
    }

    /// 卡片上「选择此设备」按钮的文案（§1.3）
    pub fn action_label(&self) -> &'static str {
        if !self.connected {
            "不可用"
        } else if self.ev_status == EvInstallStatus::Installed {
            "选择此设备"
        } else if self.ev_status == EvInstallStatus::NotInstalled {
            "请先安装"
        } else {
            "检测中…"
        }
    }
}

/// 刷新完整设备列表（含在线/离线判定 + EV 安装状态检测）
pub async fn fetch_devices() -> Vec<DeviceEntry> {
    let connected_list = device::get_connected_device_list().await;
    let all_list = device::get_device_list().await;

    let connected_addrs: Vec<String> = connected_list.iter().map(|d| d.addr.clone()).collect();

    let mut entries: Vec<DeviceEntry> = Vec::with_capacity(all_list.len());

    for d in all_list.iter() {
        let connected = connected_addrs.iter().any(|a| a == &d.addr);
        entries.push(DeviceEntry {
            name: d.name.clone(),
            addr: d.addr.clone(),
            connected,
            ev_status: if connected {
                EvInstallStatus::Checking
            } else {
                EvInstallStatus::Unknown
            },
        });
    }

    // 只对在线设备查询应用列表，离线设备跳过（拉不到，也没意义）
    for entry in entries.iter_mut() {
        if entry.connected {
            entry.ev_status = check_ev_installed(&entry.addr).await;
        }
    }

    entries
}

/// 单台设备的 EV 安装检测
async fn check_ev_installed(addr: &str) -> EvInstallStatus {
    match thirdpartyapp::get_thirdparty_app_list(addr).await {
        Ok(apps) => {
            if apps.iter().any(is_ev_schedule_app) {
                EvInstallStatus::Installed
            } else {
                EvInstallStatus::NotInstalled
            }
        }
        // 拉取失败无从判断，按 Unknown 处理，UI 上会提示刷新
        Err(_) => EvInstallStatus::Unknown,
    }
}

/// EV 课程表在手表的真实 package name
/// 来源：github.com/guomengtao/class-schedule（manifest.appName = "Ev课程表"）
/// 注意：DESIGN.md §1.4 里假设的 `com.ev.schedule` 是错的，勿用。
pub const EV_PACKAGE_NAME: &str = "com.application.watch.classschedule";

/// 判定某个三方应用是否为 EV 课程表
fn is_ev_schedule_app(app: &thirdpartyapp::AppInfo) -> bool {
    let pkg = app.package_name.trim().to_lowercase();
    if pkg == EV_PACKAGE_NAME {
        return true;
    }

    // 兜底：老版本包名可能不同，用应用名再确认一次
    let app_name = app.app_name.trim().to_lowercase();
    app_name.contains("ev课程表") || app_name.contains("ev 课程表")
}
