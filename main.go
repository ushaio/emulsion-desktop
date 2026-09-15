package main

import (
	"embed"
	"flag"
	"fmt"
	"log"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"mo-gallery-desktop/config"
	"mo-gallery-desktop/db"
	"mo-gallery-desktop/services"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/appicon.png
var icon []byte

func main() {
	// 命令行参数：指定配置文件路径
	configPath := flag.String("config", "", "配置文件路径 (默认: ~/.mo-gallery-desktop/config.json)")
	automationEnabled := flag.Bool("automation", false, "启用仅限本机的编辑器自动化接口")
	flag.Parse()

	setupFileLogging()

	// 加载配置
	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("加载配置失败: %v", err)
	}

	// Editor AI conversations are local and remain available when PostgreSQL
	// is offline. Failure here would make conversation persistence unsafe.
	if err := db.ConnectLocalAI(config.ConfigDir()); err != nil {
		log.Fatalf("初始化本地 AI 会话数据库失败: %v", err)
	}
	if err := db.ConnectLocalDrafts(config.ConfigDir()); err != nil {
		log.Fatalf("初始化本地草稿数据库失败: %v", err)
	}
	if err := db.ConnectLocalZine(config.ConfigDir()); err != nil {
		log.Fatalf("初始化本地 Zine 数据库失败: %v", err)
	}
	if err := db.ConnectLocalDesignCanvas(config.ConfigDir()); err != nil {
		log.Fatalf("初始化本地设计画布数据库失败: %v", err)
	}

	// 创建 App 实例
	app := NewApp(cfg, *automationEnabled)

	// 重启流程中，新进程需要绕过旧进程尚未释放的单实例锁。
	var singleInstanceLock *options.SingleInstanceLock
	if os.Getenv("MO_GALLERY_RESTART") != "1" {
		singleInstanceLock = &options.SingleInstanceLock{
			UniqueId: "mo-gallery-desktop-single-instance-v1",
			OnSecondInstanceLaunch: func(_ options.SecondInstanceData) {
				if app.ctx != nil {
					runtime.WindowShow(app.ctx)
					runtime.WindowUnminimise(app.ctx)
				}
			},
		}
	}

	pluginMediaHandler := services.NewPluginMediaHandler(app.StoragePlugins, config.CacheDir())

	// 启动 Wails 应用
	err = wails.Run(&options.App{
		Title:     "Emulsion",
		Width:     1440,
		Height:    900,
		MinWidth:  1024,
		MinHeight: 700,
		Frameless: true,
		AssetServer: &assetserver.Options{
			Assets:     assets,
			Middleware: services.NewDesktopAssetMiddleware(pluginMediaHandler),
			Handler: services.NewDesktopAssetHandler(
				services.NewZineAssetHandler(app.Proxy),
				app.LocalLibrary.AssetHandler(),
				pluginMediaHandler,
			),
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		// Keep production WebView free from browser chrome such as its native right-click menu.
		// Feature-specific application context menus continue to work in the frontend.
		EnableDefaultContextMenu: false,
		OnStartup:                app.startup,
		OnShutdown:               app.shutdown,
		SingleInstanceLock:       singleInstanceLock,
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop: true,
		},
		Bind: []interface{}{
			app,
		},
		Windows: &windows.Options{
			// 窗口底交给 DWM 合成：经典外观的侧栏半透明面透上去，得到的是**真正的**
			// 背景模糊 —— 由合成器做的，不是 CSS 的 backdrop-filter。
			//
			// 为什么必须走到窗口这一层：应用里侧栏与主区是并列的 flex 兄弟，内容永远
			// 不从侧栏底下经过，所以侧栏背后只有窗口底。在纯白窗底上做 backdrop-filter，
			// 实测模糊的独立贡献只有 1–5/255（等于装饰），看起来就是「一层主题色」而不是
			// 毛玻璃。整窗透明 + 亚克力之后，侧栏背后变成被 DWM 模糊过的桌面。
			//
			// WebviewIsTransparent 会把 webview 的 DefaultBackgroundColor 的 alpha 强制
			// 置 0（不看 BackgroundColour），于是 CSS 里 alpha=0 的地方就露出宿主窗口。
			// 所以前端必须自己兜住窗口底：液态玻璃外观自带不透明的光幕
			// （--lg-canvas-base），经典外观由 .desktop-content 铺实色，只有侧栏那一条
			// 故意留空 —— 见 index.css「经典外观：侧栏毛玻璃」。
			//
			// BackdropType 需要 Windows 11 build 22621+；更早的系统 WindowIsTranslucent
			// 会退回 BlurBehind（模糊仍在，只是较重）。两者都不可用时窗口依然透明，
			// 只是没有模糊 —— 也就是「透明但没磨砂」，不会坏掉。
			BackdropType:         windows.Acrylic,
			WebviewIsTransparent: true,
			WindowIsTranslucent:  true,
			// Prevent Ctrl+wheel/keyboard zoom and touch pinch zoom from making the app feel like a browser.
			IsZoomControlEnabled: false,
			DisablePinchZoom:     true,
			Theme:                windows.SystemDefault,
		},
	})

	if err != nil {
		fmt.Println("启动失败:", err.Error())
		os.Exit(1)
	}
}
