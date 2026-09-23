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
    /// 探测到的 EV 课程表实际包名（用于核对 `EV_PACKAGE_NAME` 是否正确）
    pub ev_pkg: String,
    /// 探测到的 EV 课程表实际应用名
    pub ev_name: String,
    /// 探测到的 EV 课程表完整 app-info（用于 `thirdpartyapp::launch-qa` 启动/唤醒它）
    pub ev_app_info: Option<thirdpartyapp::AppInfo>,
    // ── 以下为诊断字段 ──
    // os 接口只有 arch/hostname/platform 等只读能力，**没有任何写文件或写日志的 API**，
    // 所以排查「找不到 EV 课程表」时，唯一能看到真相的方式就是把宿主返回的内容渲染到界面上。
    /// 宿主返回的应用数量
    pub app_count: usize,
    /// 前若干个包名样本（已截断），用来核对插件实际拿到了什么
    pub sample_pkgs: String,
    /// `get_thirdparty_app_list` 调用是否失败（注意：WIT 的错误类型是 unit，取不到原因）
    pub query_error: bool,
}

/// 一次 EV 安装探测的完整结果（状态 + 诊断用原始数据）
struct EvProbe {
    status: EvInstallStatus,
    app_count: usize,
    sample_pkgs: String,
    query_error: bool,
    ev_pkg: String,
    ev_name: String,
    ev_app_info: Option<thirdpartyapp::AppInfo>,
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
            app_count: 0,
            sample_pkgs: if connected {
                String::new()
            } else {
                "设备离线，未查询".to_string()
            },
            query_error: false,
            ev_pkg: String::new(),
            ev_name: String::new(),
            ev_app_info: None,
        });
    }

    // 只对在线设备查询应用列表，离线设备跳过（拉不到，也没意义）
    for entry in entries.iter_mut() {
        if entry.connected {
            let probe = probe_ev_installed(&entry.addr).await;
            entry.ev_status = probe.status;
            entry.app_count = probe.app_count;
            entry.sample_pkgs = probe.sample_pkgs;
            entry.query_error = probe.query_error;
            entry.ev_pkg = probe.ev_pkg;
            entry.ev_name = probe.ev_name;
            entry.ev_app_info = probe.ev_app_info;
        }
    }

    entries
}

/// 单台设备的 EV 安装探测（同时收集诊断数据，供界面显示）
async fn probe_ev_installed(addr: &str) -> EvProbe {
    match thirdpartyapp::get_thirdparty_app_list(addr).await {
        Ok(apps) => {
            let app_count = apps.len();
            let matched = apps.iter().find(|a| is_ev_schedule_app(a)).cloned();
            let (ev_pkg, ev_name) = matched
                .as_ref()
                .map(|a| (a.package_name.clone(), a.app_name.clone()))
                .unwrap_or_default();
            let ev_installed = matched.is_some();

            // 取前 3 个做样本，同时显示包名与应用名
            // （兜底匹配依赖 app_name，所以必须两个字段都看得到）
            let mut sample: Vec<String> = apps
                .iter()
                .take(3)
                .map(|a| format!("{}/{}", a.package_name, a.app_name))
                .collect();
            if app_count > 3 {
                sample.push("…".to_string());
            }

            EvProbe {
                status: if ev_installed {
                    EvInstallStatus::Installed
                } else {
                    EvInstallStatus::NotInstalled
                },
                app_count,
                sample_pkgs: sample.join(", "),
                query_error: false,
                ev_pkg,
                ev_name,
                ev_app_info: matched,
            }
        }
        // WIT 里这个 future 的错误类型是 unit，拿不到具体原因，只能标记「调用失败」
        Err(()) => EvProbe {
            status: EvInstallStatus::Unknown,
            app_count: 0,
            sample_pkgs: "调用失败(get_thirdparty_app_list)".to_string(),
            query_error: true,
            ev_pkg: String::new(),
            ev_name: String::new(),
            ev_app_info: None,
        },
    }
}

/// EV 课程表在手表的真实 package name
/// 来源：github.com/guomengtao/class-schedule（manifest.appName = "Ev课程表"）
/// 注意：DESIGN.md §1.4 里假设的 `com.ev.schedule` 是错的，勿用。
pub const EV_PACKAGE_NAME: &str = "com.application.watch.classschedule";

/// 判定某个三方应用是否为 EV 课程表
///
/// 三级匹配，从严到宽：
/// 1. 包名精确等于 `com.application.watch.classschedule`
/// 2. 应用名含「ev课程表」/「ev 课程表」
/// 3. 应用名含「课程表」/「课表」——放宽是因为本就是 EV 课程表的同步插件，
///    用户设备上同时装多个课程表 App 的概率很低，宁可放宽也不要检测不到。
fn is_ev_schedule_app(app: &thirdpartyapp::AppInfo) -> bool {
    let pkg = app.package_name.trim().to_lowercase();
    if pkg == EV_PACKAGE_NAME {
        return true;
    }

    let app_name = app.app_name.trim().to_lowercase();
    if app_name.contains("ev课程表") || app_name.contains("ev 课程表") {
        return true;
    }
    app_name.contains("课程表") || app_name.contains("课表")
}
