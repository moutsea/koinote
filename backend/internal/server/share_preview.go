package server

import (
	"bytes"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

type shareSourceRange struct {
	start int
	end   int
}

// 最多返回 Markdown 源码的前半段；接近中点的完整行优先。
// 只在真实链接或图片内部回退，代码里的示例文本仍可预览。
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
	return strings.TrimRight(content[:end], " \t\r\n")
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
