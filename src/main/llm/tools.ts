export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
  items?: {
    type: string;
  };
}

export interface ToolParameters {
  type: "object";
  properties: Record<string, ToolParameter>;
  required: string[];
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolParameters;
  };
}

export const availableTools: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "使用 DuckDuckGo 搜索引擎联网查询最新信息",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索关键词，用中文或英文都可以",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_wallpapers",
      description: "使用 Wallhaven 高清壁纸库搜索并获取高分辨率电脑壁纸的直连下载链接 (支持SpaceX、动漫、极简等各种题材，不带参数即可搜索最新壁纸)",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "壁纸搜索词。如果用户想要真实的自然风光或摄影，请务必包含 'nature' 或 'photography' 等关键词（例如：'beach nature photography'）以过滤游戏CG（如GTA6）或动漫图。",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_application",
      description: "打开指定的 macOS 本地应用程序。仅在最终目标是打开应用本身时使用；访问网站或网站内搜索应直接调用 open_url 打开最终 URL，不要先打开浏览器。",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: '应用名称，例如 "Safari", "WeChat"。如果是打开默认浏览器或用户只说"打开浏览器"，请务必传入 "browser"。',
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "quit_application",
      description: "关闭指定的 macOS 应用程序",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: '应用名称，例如 "Safari", "WeChat", "OpenCode"',
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "quit_all_applications",
      description: "关闭/退出所有正在运行的桌面应用程序。默认会自动排除 Finder、Terminal、iTerm、iTerm2 和 Daisy（本程序），绝对不会意外关闭终端或桌面系统。",
      parameters: {
        type: "object",
        properties: {
          exclude_names: {
            type: "array",
            items: {
              type: "string",
            },
            description: "额外需要排除、不予关闭的应用程序名称列表，可选",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_url",
      description: "用系统默认浏览器打开指定网址/网页。调用前应先构造能直接到达用户最终目标的完整 URL；网站内搜索应尽量包含搜索路径和关键词参数，而不是只打开网站首页。",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: '要打开的网址，例如 "youtube.com" 或 "https://www.google.com"',
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description: "在当前光标位置输入一段文字（会先复制剪贴板，输入后恢复）",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "要输入的文字",
          },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "press_keys",
      description: "发送键盘快捷键",
      parameters: {
        type: "object",
        properties: {
          keys: {
            type: "string",
            description: '快捷键，例如 "command+c", "command+v", "command+tab", "return", "escape"',
          },
        },
        required: ["keys"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_frontmost_application",
      description: "获取当前最前面的应用名称",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_selected_text",
      description: "读取当前选中的文字（通过 Command+C 复制后读取剪贴板）",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "获取当前系统日期和时间（包括星期几）",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "weather_forecast",
      description: "使用 wttr.in 免费天气服务查询全球任意城市的天气。可获取实时天气、当前温度、体感温度、湿度、风速、今日最高最低温、降雨概率及未来3天预报。无需API Key。凡是天气相关问题都必须调用此工具。",
      parameters: {
        type: "object",
        properties: {
          city: {
            type: "string",
            description: "城市名称，中文或英文均可，例如「北京」「上海」「Tokyo」「New York」",
          },
          days: {
            type: "string",
            description: "预报天数，1-10，默认1（仅当天）",
          },
        },
        required: ["city"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取指定路径文件的内容（文本文件）",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "文件的绝对路径或相对用户主目录(~)的路径",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "写入内容到指定文件（覆盖写入，文件不存在则创建，会自动创建父目录）",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "文件的绝对路径或相对用户主目录(~)的路径",
          },
          content: {
            type: "string",
            description: "要写入的完整内容",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_file",
      description: "创建一个新文件（如果文件已存在会报错，避免误覆盖）",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "文件的绝对路径或相对用户主目录(~)的路径",
          },
          content: {
            type: "string",
            description: "文件初始内容，默认为空",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "删除指定文件或空目录",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "要删除的文件或空目录的绝对路径",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "列出指定目录下的文件和文件夹",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "目录路径，默认为用户桌面",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell_command",
      description: "执行终端命令（shell command），可以安装软件、管理文件、运行脚本等。用于以上工具无法覆盖的场景",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "要执行的终端命令",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_note",
      description: "在 macOS 备忘录(Notes)应用中创建一条新备忘录",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "备忘录标题",
          },
          body: {
            type: "string",
            description: "备忘录正文内容",
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_reminder",
      description: "在 macOS 提醒事项(Reminders)应用中创建一条新提醒，可设置提醒时间",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "提醒内容",
          },
          due_date: {
            type: "string",
            description: "提醒时间，格式为「YYYY-MM-DD HH:MM」，例如「2026-06-27 14:30」。如不指定则不设时间",
          },
          notes: {
            type: "string",
            description: "备注（可选）",
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_calendar_event",
      description: "在 macOS 日历(Calendar)应用中创建一个新事件",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "事件标题",
          },
          start_date: {
            type: "string",
            description: "开始时间，格式为「YYYY-MM-DD HH:MM」，例如「2026-06-27 14:00」",
          },
          end_date: {
            type: "string",
            description: "结束时间，格式同上。如不指定则默认1小时后",
          },
          location: {
            type: "string",
            description: "地点（可选）",
          },
          notes: {
            type: "string",
            description: "备注（可选）",
          },
        },
        required: ["title", "start_date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_calendar_events",
      description: "获取 macOS 日历中接下来指定天数内的事件",
      parameters: {
        type: "object",
        properties: {
          days: {
            type: "string",
            description: "查询未来多少天内的事件，默认7天",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_notes",
      description: "在 macOS 备忘录中搜索包含指定关键词的笔记",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索关键词",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_timer",
      description: "设置一个倒计时计时器，到时间后播放提示音并弹出系统通知",
      parameters: {
        type: "object",
        properties: {
          seconds: {
            type: "string",
            description: "计时秒数，例如「300」表示5分钟",
          },
        },
        required: ["seconds"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_alarm",
      description: "设置一个闹钟到指定时间，到时间会响铃并弹出系统通知。用于「明天早上7点叫醒我」「设一个下午3点的闹钟」等场景。",
      parameters: {
        type: "object",
        properties: {
          time: {
            type: "string",
            description: "闹钟时间，格式为「YYYY-MM-DD HH:MM」，例如「2026-06-27 07:00」。如果用户说「明天早上7点」，请先调用 get_current_time 获取当前日期，再计算出完整日期时间。",
          },
          label: {
            type: "string",
            description: "闹钟标签/备注（可选）",
          },
        },
        required: ["time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_maps",
      description: "在 macOS 地图(Maps)应用中搜索地点",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "要搜索的地点名称或地址",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "sports_schedule",
      description: "查询足球联赛赛程（英超、西甲、德甲、意甲、法甲、欧冠、欧联、中超、日职联、韩职联等）。用户问比赛赛程、对阵、时间时使用此工具，不要用 web_search。",
      parameters: {
        type: "object",
        properties: {
          league: {
            type: "string",
            description: "联赛名称，如「英超」「西甲」「欧冠」「中超」等",
          },
        },
        required: ["league"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "download_media",
      description: "使用 yt-dlp 免费下载网络上的视频或音频（支持YouTube、Bilibili、抖音等数千个网站）。文件会被自动保存到用户的下载（Downloads）文件夹中。",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "要下载的视频、音频或网页的 URL 链接",
          },
          type: {
            type: "string",
            enum: ["video", "audio"],
            description: "下载类型，'video' 表示下载完整视频，'audio' 表示只下载并提取音频（如 MP3）",
          },
          destination: {
            type: "string",
            description: "下载文件的保存目录路径，可选。例如 '~/Desktop' 表示桌面。如果不提供，默认保存到用户的下载文件夹 (Downloads)。",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scrape_url",
      description: "提取在线网页的纯净文本内容（剔除导航栏、侧边栏、广告等无关内容，只保留主体文字，常用于获取网页、文章或文档的具体正文进行理解与分析）",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "要提取正文内容的网页 URL",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_clipboard_text",
      description: "获取用户当前 macOS 系统剪切板（Clipboard）中的纯文本内容",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_clipboard_text",
      description: "将指定文本写入用户当前 macOS 系统剪切板（Clipboard）中，直接覆盖旧内容",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "要写入剪贴板的纯文本内容",
          },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_email",
      description: "调用本地 macOS Mail 应用程序快速发送一封邮件（静默发送，无需用户干预确认）",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "收件人邮箱地址，例如 'example@domain.com'",
          },
          subject: {
            type: "string",
            description: "邮件主题（不写默认为'无主题'）",
          },
          body: {
            type: "string",
            description: "邮件正文内容，支持换行",
          },
        },
        required: ["to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_unread_emails",
      description: "调用本地 macOS Mail 应用读取收件箱中的未读邮件列表（最新邮件排在最前面）",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description: "要获取的未读邮件数量，默认和推荐为 5",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_emails",
      description: "调用本地 macOS Mail 应用读取收件箱中的最新邮件列表（包括已读和未读，最合适用户需要看最近邮件、今天/昨天有哪些邮件等场景，最新邮件排在最前面）",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description: "要获取的最新邮件数量，默认和推荐为 5",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_emails",
      description: "在本地 macOS Mail 中搜索收件箱中包含特定关键字的邮件（包括发件人、发件地址、主题或正文关键字，最新匹配邮件排在最前面）",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索关键字（可以是发件人、主题关键词、正文关键词或日期等）",
          },
          limit: {
            type: "integer",
            description: "最多获取匹配邮件的数量，默认和推荐为 5",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "switch_audio_output",
      description: "切换 macOS 音频输出设备（如耳机、外放、扬声器等）。会直接调用系统命令 SwitchAudioSource 进行切换，无需额外确认。",
      parameters: {
        type: "object",
        properties: {
          device: {
            type: "string",
            description: "要切换到的音频输出设备名称，例如「外置耳机」「Mac mini扬声器」「耳机」「外放」等",
          },
        },
        required: ["device"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "trim_video",
      description: "从视频中截取指定时间段，保存为新文件。",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "源视频文件路径",
          },
          start: {
            type: "string",
            description: "起始时间，格式如 00:01:02 或 1:02",
          },
          end: {
            type: "string",
            description: "结束时间，格式如 00:01:08 或 1:08",
          },
          output: {
            type: "string",
            description: "输出文件名（不含路径，默认保存到桌面）",
          },
        },
        required: ["source", "start", "end"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "convert_video",
      description: "转换视频格式（如 MP4、MOV、AVI、MKV、WebM 等互转）。",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "源视频文件路径",
          },
          format: {
            type: "string",
            description: "目标格式，如 mp4、mov、avi、mkv、webm、gif 等",
          },
          output: {
            type: "string",
            description: "输出文件名（不含路径，默认保存到桌面）",
          },
        },
        required: ["source", "format"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "convert_document",
      description: "转换文档格式（TXT、Markdown、DOCX、PDF、RTF、HTML 等任意文档格式互转）。自动选择最佳转换方式，无需关心底层工具。",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "源文件路径",
          },
          target: {
            type: "string",
            description: "目标文件路径（扩展名决定输出格式）",
          },
        },
        required: ["source", "target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_document",
      description: "编辑 Word 文档（.docx）。删除指定颜色文字时自动保留下划线、粗体等格式（替换为等长空格）。页码通过解析文档内部的节分页符（section break）来定位，精确可靠。",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "源 .docx 文件路径",
          },
          target: {
            type: "string",
            description: "输出 .docx 文件路径（不覆盖源文件）",
          },
          operation: {
            type: "string",
            enum: ["remove_colored_text", "run_code"],
            description: "操作类型。remove_colored_text: 删除指定颜色文字; run_code: 执行自定义 Python 代码（doc 对象可用）",
          },
          color: {
            type: "string",
            description: "要删除的文字颜色（十六进制 RGB），如 FF0000（红）。remove_colored_text 需要",
          },
          page_start: {
            type: "integer",
            description: "起始页码（从1开始），可选，不填则处理全文",
          },
          page_end: {
            type: "integer",
            description: "结束页码（含），需和 page_start 一起用",
          },
          code: {
            type: "string",
            description: "自定义 Python 代码（仅 run_code 需要）。doc/W_NS/RGBColor 可用，不要 import 和 doc.save()",
          },
        },
        required: ["source", "target", "operation"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_pdf",
      description: "直接在 PDF 上原地修改（不转 Word，100% 保留原版面/字体/颜色）。只有 PDF、无源 docx 时用。operation: find=搜索文本返回坐标; fill=在锚点右侧填入文字(填空/答案); delete=删文字(按文本或按颜色,如删所有红字); replace=替换文字。",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", description: "源 .pdf 路径" },
          target: { type: "string", description: "输出 .pdf 路径" },
          operation: { type: "string", enum: ["find", "fill", "delete", "replace"], description: "操作类型" },
          query: { type: "string", description: "find/replace 时搜索的文本" },
          anchor: { type: "string", description: "fill 定位锚点(在其右侧填入文字)" },
          text: { type: "string", description: "fill 填入文字; delete 按文本时为要删的文本; replace 新文字" },
          color: { type: "string", description: "十六进制 RGB 如 FF0000。fill/replace 文字颜色; delete 按 color 时为要删的颜色" },
          fontsize: { type: "integer", description: "fill 字号默认 11" },
          mode: { type: "string", enum: ["text", "color"], description: "delete: text=按文本删, color=按颜色删" },
          replace_with: { type: "string", description: "replace 替换后的新文字" }
        },
        required: ["source", "target", "operation"]
      }
    }
  },
];

export interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  tool_call_id: string;
  role: "tool";
  content: string;
}
