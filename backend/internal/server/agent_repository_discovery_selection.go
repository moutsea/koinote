package server

import (
	"strings"
	"unicode"
)

// At most 24 search requests before retries. Keep the existing 100-Star floor
// and daily allowance; narrower queries expand relevance rather than volume.
var systemRepositoryDiscoverySearches = []struct {
	query string
	pages int
}{
	{"writing skill in:name,description", 2},
	{"写作 skill in:name,description", 2},
	{"obsidian skill in:name,description", 2},
	{"knowledge skill in:name,description", 2},
	{`"second brain" skill in:name,description`, 2},
	{"humanizer in:name,description", 2},
	{"skills in:name,description", 3},
	{"topic:agent-skills", 3},
	{"topic:claude-skills", 3},
	{"topic:skills", 3},
}

// Classify by the repository's purpose, not the agent it runs in. Names carry
// stronger intent than incidental words in descriptions; generic or mixed skill
// collections remain in agents. Keep the existing category vocabulary.
func systemRepositoryDiscoveryCategory(name, description, repositoryURL string, reviews ...koiRepositoryCuration) string {
	var review koiRepositoryCuration
	if len(reviews) > 0 {
		review = reviews[0]
	}
	owner, repo, _, err := parseGitHubRepositoryURL(repositoryURL)
	if err == nil {
		if category := review.categories[strings.ToLower("https://github.com/"+owner+"/"+repo)]; category != "" {
			return category
		}
	}
	normalize := func(value string) string {
		return " " + strings.Join(strings.FieldsFunc(strings.ToLower(value), func(r rune) bool {
			return !unicode.IsLetter(r) && !unicode.IsNumber(r)
		}), " ") + " "
	}
	contains := func(text string, terms []string) bool {
		for _, term := range terms {
			if strings.Contains(text, " "+term+" ") || (term[0] >= 128 && strings.Contains(text, term)) {
				return true
			}
		}
		return false
	}
	rules := []struct {
		category            string
		names, descriptions []string
	}{
		{"research",
			[]string{"research", "academic", "paper", "phd", "obsidian", "knowledge", "scholar", "study", "second brain", "learn from materials", "finance", "stock", "trading", "trader", "investor", "investorskills", "socrates", "feynman"},
			[]string{"knowledge management", "knowledge base", "knowledge linking", "obsidian", "second brain", "note taking", "literature review", "academic reading", "academic writing", "paper writing", "paper review", "stock research", "financial analysis", "data analysis", "teaching skill", "知识", "笔记", "论文", "文献", "研究报告", "数据分析", "金融分析", "选股"}},
		{"writing",
			[]string{"writing", "writer", "humanizer", "humanize", "copywriting", "novelist", "screenwriting", "tech doc", "stop slop", "less ai tone", "self media content", "wechat article", "document format"},
			[]string{"creative writing", "technical writing", "writing skill", "writing skills", "writing style", "writing patterns", "rewrites text", "humanizer", "humanize", "copywriting", "rewriting ambiguous", "ai tells from prose", "ai tone removal", "document formatting", "写作", "润色", "去ai味", "去 ai 味", "小说", "自媒体内容", "选题", "公文"}},
		{"media",
			[]string{"slides", "pptx", "ffmpeg", "blender", "video", "motion", "motionmaxxing", "2dimg2motion", "diagram", "illustrations", "youtube"},
			[]string{"motion graphics", "motion design", "animation sequences", "isometric figures", "isometric illustrations", "slide studio", "video editor", "blender", "spritesheets", "illustrations", "动画", "视频", "配图", "幻灯片", "演示文稿"}},
		{"design",
			[]string{"ui", "ux", "design", "designer", "interfaces", "brand identity", "app store screenshots", "poster", "higagentskills"},
			[]string{"ui design", "interface design", "human interface guidelines", "readme design", "design skill", "design tokens", "design systems", "brand identity", "app store screenshot", "landing page", "界面设计", "视觉设计", "品牌设计"}},
		{"product",
			[]string{"marketing", "seo", "superseo", "gtm", "founder", "startup", "ecommerce", "amazon", "xiaohongshuskills", "instagram", "product development", "product engineering"},
			[]string{"marketing", "seo", "amazon sellers", "startup founders", "product specifications", "product planning", "product analytics", "pricing strategy", "competitor analysis", "营销", "行销", "运营", "电商", "产品规划", "增长"}},
		{"development",
			[]string{"swiftui", "compose", "rust", "beautifulrust", "typescript", "threejs", "wordpress", "full stack", "spec driven", "terrashark", "codebase", "console", "claude ad", "security audit", "website rebuild", "game studios", "gemini", "gemma", "langchain"},
			[]string{"coding skills", "software bugs", "software engineering", "development lifecycle", "spec driven development", "app starter", "production grade applications", "rust", "swiftui", "macos apps", "android development", "jetpack compose", "wordpress", "pentest", "security best practices", "terraform", "oxlint", "reverse engineer the code", "codebase", "api integration", "全栈开发", "软件开发", "编码任务", "api 集成"}},
	}
	n, d := normalize(name), normalize(description)
	for _, rule := range rules {
		if contains(n, rule.names) {
			return rule.category
		}
	}
	// A broad toolkit mentioning several domains is still a mixed collection.
	// A host name such as Claude Code or Codex is never a development signal.
	domains := 0
	for _, terms := range [][]string{
		{"marketing", "sales", "seo", "营销", "运营"},
		{"design", "designs", "界面", "设计"},
		{"engineering", "development", "dev", "coding skills", "开发"},
		{"research", "knowledge", "研究", "知识"},
		{"writing", "content", "写作", "内容"},
	} {
		if contains(d, terms) {
			domains++
		}
	}
	if domains >= 3 {
		return "agents"
	}
	// Business and engineering context beats incidental research/writing words.
	for _, category := range []string{"product", "development", "research", "writing", "media", "design"} {
		for _, rule := range rules {
			if rule.category == category && contains(d, rule.descriptions) {
				return category
			}
		}
	}
	return "agents"
}
