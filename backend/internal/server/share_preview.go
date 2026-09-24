package server

import (
	"bytes"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

type shareSourceRange struct {
	start int
	end   int
}

type shareReferenceUse struct {
	start      int
	end        int
	labelStart int
	labelEnd   int
	key        string
}

// 从 Markdown 源码的前半段生成预览；接近中点的完整行优先。
// 引用定义在隐藏部分时只保留可见的标签文字，不泄露链接地址。
func sharePreview(content string) string {
	cutoffRunes := utf8.RuneCountInString(content) / 2
	if cutoffRunes == 0 {
		return ""
	}
	lowerRunes := cutoffRunes * 4 / 5
	lower, cutoff := 0, 0
	index := 0
	for offset := range content {
		if index == lowerRunes {
			lower = offset
		}
		if index == cutoffRunes {
			cutoff = offset
			break
		}
		index++
	}

	source := []byte(content)
	rawRanges := shareRawMarkdownRanges(source)
	end := cutoff
	for i := cutoff - 1; i >= lower; i-- {
		if source[i] == '\n' {
			if shareSafeInlineCutoff(source, i, rawRanges) == i {
				end = i
			}
			break
		}
	}
	if end == cutoff {
		end = shareSafeInlineCutoff(source, cutoff, rawRanges)
	}
	return strings.TrimRight(shareReadableReferences(source, end, rawRanges), " \t\r\n")
}

// Goldmark 只会将真实的引用定义加入上下文。预览缺少定义时，已经可见的
// 引用用法会退化成普通文字；跨中点的用法则回退到开始处。
func shareReadableReferences(source []byte, end int, rawRanges []shareSourceRange) string {
	if !bytes.Contains(source[:end], []byte("[")) || !bytes.Contains(source, []byte("]:")) {
		return string(source[:end])
	}
	fullContext := parser.NewContext()
	root := goldmark.DefaultParser().Parse(text.NewReader(source), parser.WithContext(fullContext))
	if len(fullContext.References()) == 0 {
		return string(source[:end])
	}
	linkCodeRanges := shareLinkCodeRanges(root, len(source))

	type bracket struct{ start, labelStart int }
	var stack []bracket
	var uses []shareReferenceUse
	rawIndex := 0
	codeIndex := 0
	failedInlineDestination := false
	for i := 0; i < len(source); {
		for rawIndex < len(rawRanges) && i >= rawRanges[rawIndex].end {
			rawIndex++
		}
		if rawIndex < len(rawRanges) && i >= rawRanges[rawIndex].start {
			i = rawRanges[rawIndex].end
			stack = nil
			continue
		}
		for codeIndex < len(linkCodeRanges) && i >= linkCodeRanges[codeIndex].end {
			codeIndex++
		}
		if codeIndex < len(linkCodeRanges) && i >= linkCodeRanges[codeIndex].start {
			// 标签中的代码不是引用用法，但外层的链接边界仍需继续扫描。
			i = linkCodeRanges[codeIndex].end
			continue
		}
		switch source[i] {
		case '\\':
			i += min(2, len(source)-i)
		case '<':
			if next := shareAutoLinkEnd(source, i); next > i {
				i = next
			} else {
				i++
			}
		case '[':
			start := i
			if i > 0 && source[i-1] == '!' {
				start--
			}
			stack = append(stack, bracket{start, i + 1})
			i++
		case ']':
			if len(stack) == 0 {
				i++
				continue
			}
			open := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			labelEnd := i
			useEnd := i + 1
			keyLabel := source[open.labelStart:labelEnd]
			if useEnd < len(source) && source[useEnd] == '(' {
				if !failedInlineDestination {
					if inlineEnd := shareInlineDestinationEnd(source, useEnd); inlineEnd > useEnd {
						i = inlineEnd
					} else {
						// 后续候选不能再从各自的位置重复扫描到末尾。
						failedInlineDestination = true
						i++
					}
				} else {
					i++
				}
				continue
			}
			if useEnd < len(source) && source[useEnd] == '[' {
				close := useEnd + 1
				for close < len(source) && source[close] != ']' && source[close] != '\n' {
					if source[close] == '\\' && close+1 < len(source) {
						close += 2
					} else {
						close++
					}
				}
				if close >= len(source) || source[close] != ']' {
					i++
					continue
				}
				if close > useEnd+1 {
					keyLabel = source[useEnd+1 : close]
				}
				useEnd = close + 1
			} else if useEnd < len(source) && source[useEnd] == ':' {
				// 引用定义本身不是引用用法。
				i++
				continue
			}
			key := util.ToLinkReference(keyLabel)
			if _, ok := fullContext.Reference(key); ok {
				uses = append(uses, shareReferenceUse{open.start, useEnd, open.labelStart, labelEnd, key})
				if open.start < end && useEnd > end {
					end = open.start
				}
			}
			i++
		default:
			i++
		}
	}
	if len(uses) == 0 {
		return string(source[:end])
	}
	previewContext := parser.NewContext()
	goldmark.DefaultParser().Parse(text.NewReader(source[:end]), parser.WithContext(previewContext))
	sort.Slice(uses, func(i, j int) bool { return uses[i].start < uses[j].start })
	var result strings.Builder
	last := 0
	for _, use := range uses {
		if use.start < last || use.end > end {
			continue
		}
		if _, ok := previewContext.Reference(use.key); ok {
			continue
		}
		result.Write(source[last:use.start])
		result.Write(source[use.labelStart:use.labelEnd])
		last = use.end
	}
	result.Write(source[last:end])
	return result.String()
}

// 截断扫描要保留完整链接，引用改写却不能碰链接标签中的代码文字。
func shareLinkCodeRanges(root ast.Node, sourceLength int) []shareSourceRange {
	var ranges []shareSourceRange
	_ = ast.Walk(root, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering || node.Kind() != ast.KindCodeSpan {
			return ast.WalkContinue, nil
		}
		inLink := false
		for parent := node.Parent(); parent != nil; parent = parent.Parent() {
			if parent.Kind() == ast.KindLink || parent.Kind() == ast.KindImage {
				inLink = true
				break
			}
		}
		if !inLink {
			return ast.WalkContinue, nil
		}
		start, end := sourceLength, 0
		for child := node.FirstChild(); child != nil; child = child.NextSibling() {
			if code, ok := child.(*ast.Text); ok {
				start = min(start, code.Segment.Start)
				end = max(end, code.Segment.Stop)
			}
		}
		if start < end {
			ranges = append(ranges, shareSourceRange{start, end})
		}
		return ast.WalkContinue, nil
	})
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].start < ranges[j].start })
	return ranges
}

// 跳过完整行内链接的地址和标题，避免把 URL 中的方括号当作引用用法。
func shareInlineDestinationEnd(source []byte, open int) int {
	depth := 1
	var quote byte
	angle := false
	afterSpace := false
	for i := open + 1; i < len(source); i++ {
		switch {
		case source[i] == '\\':
			i++
			afterSpace = false
		case angle:
			if source[i] == '>' {
				angle = false
			}
		case quote != 0:
			if source[i] == quote {
				quote = 0
			}
		case depth == 1 && shareMarkdownSpace(source[i]):
			afterSpace = true
		case source[i] == '<':
			angle = true
			afterSpace = false
		case afterSpace && (source[i] == '"' || source[i] == '\''):
			quote = source[i]
			afterSpace = false
		case source[i] == '(':
			afterSpace = false
			depth++
		case source[i] == ')':
			afterSpace = false
			depth--
			if depth == 0 {
				return i + 1
			}
		default:
			afterSpace = false
		}
	}
	return 0
}

// Goldmark 的源码片段告诉扫描器哪些文字实际处于代码或 HTML 块中。
// 没有这些语法的普通段落不需要构造 AST，避免大篇幅纯文本增加解析开销。
func shareRawMarkdownRanges(source []byte) []shareSourceRange {
	if bytes.IndexAny(source, "`~<\t") < 0 && !bytes.Contains(source, []byte("    ")) {
		return nil
	}
	root := goldmark.DefaultParser().Parse(text.NewReader(source))
	var ranges []shareSourceRange
	add := func(start, end int) {
		if start >= 0 && end > start && end <= len(source) {
			ranges = append(ranges, shareSourceRange{start, end})
		}
	}
	_ = ast.Walk(root, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch node.Kind() {
		case ast.KindFencedCodeBlock, ast.KindCodeBlock, ast.KindHTMLBlock:
			lines := node.Lines()
			start, end := len(source), 0
			for i := 0; i < lines.Len(); i++ {
				segment := lines.At(i)
				start = min(start, segment.Start)
				end = max(end, segment.Stop)
			}
			if fenced, ok := node.(*ast.FencedCodeBlock); ok && fenced.Info != nil {
				start = min(start, fenced.Info.Segment.Start)
				end = max(end, fenced.Info.Segment.Stop)
			}
			add(start, end)
		case ast.KindRawHTML:
			html := node.(*ast.RawHTML)
			start, end := len(source), 0
			for i := 0; i < html.Segments.Len(); i++ {
				segment := html.Segments.At(i)
				start = min(start, segment.Start)
				end = max(end, segment.Stop)
			}
			add(start, end)
		case ast.KindCodeSpan:
			// 链接或图片标签里的行内代码仍属于外层完整语法单元。
			for parent := node.Parent(); parent != nil; parent = parent.Parent() {
				if parent.Kind() == ast.KindLink || parent.Kind() == ast.KindImage {
					return ast.WalkContinue, nil
				}
			}
			start, end := len(source), 0
			for child := node.FirstChild(); child != nil; child = child.NextSibling() {
				if code, ok := child.(*ast.Text); ok {
					start = min(start, code.Segment.Start)
					end = max(end, code.Segment.Stop)
				}
			}
			add(start, end)
		}
		return ast.WalkContinue, nil
	})
	if len(ranges) < 2 {
		return ranges
	}
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].start < ranges[j].start })
	merged := ranges[:1]
	for _, current := range ranges[1:] {
		last := &merged[len(merged)-1]
		if current.start <= last.end {
			last.end = max(last.end, current.end)
		} else {
			merged = append(merged, current)
		}
	}
	return merged
}

// 只检查 cutoff 所在的非代码区间；图片、链接不可能跨过代码片段。
func shareSafeInlineCutoff(source []byte, cutoff int, rawRanges []shareSourceRange) int {
	start, stop := 0, len(source)
	for _, raw := range rawRanges {
		if cutoff >= raw.start && cutoff < raw.end {
			return cutoff
		}
		if raw.end <= cutoff {
			start = raw.end
			continue
		}
		if raw.start >= cutoff {
			stop = raw.start
			break
		}
	}
	return start + shareSafeMarkupCutoff(source[start:stop], cutoff-start)
}

// 单次扫描当前行内区域，保留跨过 cutoff 的图片、链接和自动链接的完整边界。
func shareSafeMarkupCutoff(source []byte, cutoff int) int {
	end := cutoff
	var starts []int
	for i := 0; i < len(source); {
		switch source[i] {
		case '\\':
			i += min(2, len(source)-i)
		case '!':
			if i+1 < len(source) && source[i+1] == '[' {
				starts = append(starts, i)
				i += 2
			} else {
				i++
			}
		case '[':
			starts = append(starts, i)
			i++
		case '<':
			if next := shareAutoLinkEnd(source, i); next > i {
				if i < cutoff && next > cutoff && i < end {
					end = i
				}
				i = next
			} else {
				i++
			}
		case ']':
			if len(starts) == 0 || i+1 >= len(source) || source[i+1] != '(' {
				if len(starts) > 0 {
					starts = starts[:len(starts)-1]
				}
				i++
				continue
			}
			start := starts[len(starts)-1]
			starts = starts[:len(starts)-1]
			i += 2
			parens := 1
			angle := i
			for angle < len(source) && shareMarkdownSpace(source[angle]) {
				angle++
			}
			if angle < len(source) && source[angle] == '<' {
				i = angle + 1
				for i < len(source) {
					if source[i] == '\\' && i+1 < len(source) {
						i += 2
						continue
					}
					if source[i] == '>' {
						i++
						break
					}
					i++
				}
			}
			var titleQuote byte
			afterSpace := false
			for i < len(source) && parens > 0 {
				if source[i] == '\\' && i+1 < len(source) {
					i += 2
					continue
				}
				if titleQuote != 0 {
					if source[i] == titleQuote {
						titleQuote = 0
					}
					i++
					continue
				}
				if parens == 1 && shareMarkdownSpace(source[i]) {
					afterSpace = true
					i++
					continue
				}
				if afterSpace && (source[i] == '"' || source[i] == '\'') {
					titleQuote = source[i]
					afterSpace = false
					i++
					continue
				}
				afterSpace = false
				switch source[i] {
				case '(':
					parens++
				case ')':
					parens--
				}
				i++
			}
			if parens == 0 && start < cutoff && i > cutoff && start < end {
				end = start
			}
		default:
			i++
		}
	}
	return end
}

func shareMarkdownSpace(value byte) bool {
	return value == ' ' || value == '\t' || value == '\r' || value == '\n'
}

func shareAutoLinkEnd(source []byte, start int) int {
	i := start + 1
	for i < len(source) && source[i] != '>' && source[i] != '<' && !shareMarkdownSpace(source[i]) {
		i++
	}
	if i >= len(source) || source[i] != '>' || i == start+1 {
		return 0
	}
	value := source[start+1 : i]
	colon := bytes.IndexByte(value, ':')
	if colon >= 2 && colon <= 32 && shareASCIIAlpha(value[0]) {
		valid := true
		for _, char := range value[1:colon] {
			if !shareASCIIAlpha(char) && (char < '0' || char > '9') && char != '+' && char != '.' && char != '-' {
				valid = false
				break
			}
		}
		if valid {
			return i + 1
		}
	}
	if at := bytes.IndexByte(value, '@'); at > 0 && at < len(value)-1 {
		return i + 1
	}
	return 0
}

func shareASCIIAlpha(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z'
}
