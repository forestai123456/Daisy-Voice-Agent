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
      name: "diagnose_application",
      description: "只读诊断指定应用为何无法打开：检查已安装启动项、文件是否存在、是否仍有进程运行，以及 Windows 最近 7 天的相关崩溃或挂起记录。绝不会启动、关闭或修改该应用。",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "要诊断的应用名称，例如 微信、Chrome、Word。",
          },
        },
        required: ["name"],
      },
    },
  },
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
      name: "scrape_url",
      description: "使用 Firecrawl 爬虫工具直接爬取指定网页的完整内容（转换为 Markdown 格式返回，适用于需要读取特定链接网页内容、新闻或推特主页推文等场景）",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "要爬取的完整网址（例如 https://x.com/username 或 https://example.com/article）",
          },
        },
        required: ["url"],
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
      description: "打开指定的应用程序",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: '应用名称，例如 "WeChat", "Chrome", "Notepad", "Word"。如果是打开默认浏览器或用户只说"打开浏览器"，请务必传入 "browser"。',
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
      description: "关闭指定的应用程序",
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
      description: "用系统默认浏览器打开指定网址/网页",
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
      name: "get_clipboard_text",
      description: "直接读取用户当前剪贴板（Clipboard）中的文本内容（适用于用户说“读取我刚刚复制的内容”、“读取我复制的链接”等场景）",
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
      description: "将指定的文本直接写入用户的系统剪贴板中，以便用户可以直接使用 Command + V 粘贴（适用于用户说“复制以下内容”、“帮我把回复的内容复制到剪贴板”等场景）",
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
      description: "调用本地 Mail 应用发送电子邮件（适用于发件、发信、给某人发邮箱等场景）。macOS 限定，Windows 暂不支持。",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description: "收件人的电子邮箱地址（例如 test@example.com）",
          },
          subject: {
            type: "string",
            description: "邮件的主题/标题",
          },
          body: {
            type: "string",
            description: "邮件的正文内容",
          },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_unread_emails",
      description: "调用本地 Mail 应用读取收件箱中的最新未读邮件（适用于用户说“读一下我最新的邮件”、“有没有未读邮件”等场景）。macOS 限定，Windows 暂不支持。",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description: "最多获取邮件的数量，默认和推荐为 5",
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
      description: "调用本地 Mail 应用读取收件箱中的最新邮件列表（包括已读和未读，最合适用户需要看最近邮件、今天/昨天有哪些邮件等场景，最新邮件排在最前面）。macOS 限定，Windows 暂不支持。",
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
      description: "在备忘录(Notes)应用中创建一条新备忘录。macOS Notes.app 限定，Windows 暂不支持。",
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
      description: "在提醒事项(Reminders)应用中创建一条新提醒，可设置提醒时间。macOS Reminders.app 限定，Windows 暂不支持。",
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
      description: "在日历(Calendar)应用中创建一个新事件。macOS Calendar.app 限定，Windows 暂不支持。",
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
      description: "获取日历中接下来指定天数内的事件。macOS Calendar.app 限定，Windows 暂不支持。",
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
      description: "在备忘录中搜索包含指定关键词的笔记。macOS Notes.app 限定，Windows 暂不支持。",
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
      description: "在地图(Maps)应用中搜索地点。macOS 限定；Windows 会改为在浏览器中打开 Bing 地图。",
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
      name: "switch_audio_output",
      description: "切换音频输出设备（如耳机、外放、扬声器等）。macOS 限定（调用 SwitchAudioSource），Windows 暂不支持。",
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
      name: "office_document",
      description: "使用 OfficeCLI 创建、编辑或转换 Word、Excel、PowerPoint 文档。首次调用会自动下载安装并校验 OfficeCLI，之后会在后台安全更新。创建时 operation=create 且提供 target；编辑前先 inspect 或 query 读取结构；edit 必须传入 JSON 操作数组，工具会复制到 target、原子编辑并自动校验。PDF 原地编辑请使用 edit_pdf。",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "除 create 外必填的源文件路径。支持 .docx、.xlsx、.pptx",
          },
          target: {
            type: "string",
            description: "create、edit 或 convert 的输出路径；edit 会先复制 source 到 target，保留源文件不变",
          },
          operation: {
            type: "string",
            enum: ["create", "inspect", "query", "edit", "validate", "convert"],
            description: "create=从零创建 .docx/.xlsx/.pptx；inspect=读取带格式的结构；query=按选择器查找；edit=对 target 执行原子批量编辑；validate=校验 OpenXML 文档；convert=优先用 OfficeCLI 导出 HTML/PNG/SVG/PDF，其他格式自动使用 Daisy 兼容转换兜底",
          },
          query: {
            type: "string",
            description: "query 操作的 OfficeCLI 选择器，例如 paragraph[style=Heading1] 或 run:contains(TODO)",
          },
          commands: {
            type: "string",
            description: "仅 edit 使用：OfficeCLI batch JSON 数组。每项仅允许 set、add、remove、move、swap；先 inspect/query 确认元素路径，再生成操作。示例：[{\"command\":\"set\",\"path\":\"/body/p[1]\",\"props\":{\"text\":\"新标题\"}}]",
          },
        },
        required: ["operation"],
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
