package server

import (
	"bytes"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

type shareSourceRange struct {
	start              int
	end                int
	breaksBracketStack bool
	inlineHTML         bool
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

// 只将前端接受的引用定义加入上下文。预览缺少定义时，已经可见的
// 引用用法会退化成普通文字；跨中点的用法则回退到开始处。
func shareReadableReferences(source []byte, end int, rawRanges []shareSourceRange) string {
	// 中点也可能刚好位于 ! 与 [ 之间，需把整个引用图片退回起点。
	if !bytes.Contains(source[:min(end+1, len(source))], []byte("[")) || !bytes.Contains(source, []byte("]:")) {
		return string(source[:end])
	}
	fullContext := parser.NewContext()
	root := sharePreviewParser.Parse(text.NewReader(source), parser.WithContext(fullContext))
	// 引用定义由 Goldmark 从段落节点移除；这些源码行不属于正文引用用法。
	definitions := shareUnrenderedReferenceRanges(root, source)
	for _, definition := range definitions {
		completeEnd := definition.start + len(bytes.TrimRight(source[definition.start:definition.end], " \t\r\n"))
		if definition.start < end && end < completeEnd {
			// 连尖括号或标题都未闭合时，前端可能把半截定义作为正文
			// 自动识别成链接，因此不能只去掉引用用法，还要撤回残缺定义。
			end = definition.start
			break
		}
	}
	previewContext := parser.NewContext()
	previewRoot := sharePreviewParser.Parse(text.NewReader(source[:end]), parser.WithContext(previewContext))
	// 无效定义被截断后也可能变为有效定义，例如 javascript:bad 被截成 java。
	// 撤回仅在预览末尾新产生的定义，避免普通标签突然变为错误地址的链接。
	if len(previewContext.References()) > 0 && end < len(source) {
		for _, definition := range shareUnrenderedReferenceRanges(previewRoot, source[:end]) {
			if definition.end == end && !shareRangesContain(definitions, definition.start, definition.end) {
				end = definition.start
				previewContext = parser.NewContext()
				sharePreviewParser.Parse(text.NewReader(source[:end]), parser.WithContext(previewContext))
				break
			}
		}
	}
	if len(fullContext.References()) == 0 {
		return string(source[:end])
	}
	previewEnd := end
	rawRanges = shareMergeSourceRanges(append(append([]shareSourceRange(nil), rawRanges...), definitions...))
	// 引用定义不能包含未转义的方括号。先索引这些位置，嵌套候选直接
	// 排除，不反复规范化重叠的长标签；普通长标签和中文标签仍可读取。
	var referenceBrackets []int
	for i := 0; i < len(source); i++ {
		if source[i] == '\\' && i+1 < len(source) && util.IsPunct(source[i+1]) {
			i++
		} else if source[i] == '[' || source[i] == ']' {
			referenceBrackets = append(referenceBrackets, i)
		}
	}

	type bracket struct{ start, labelStart int }
	var stack []bracket
	var uses []shareReferenceUse
	var inlineMarkup []shareReferenceUse
	var referenceImages []shareReferenceUse
	var brackets []shareSourceRange
	var imageLabels []shareSourceRange
	rawIndex := 0
	destinations := shareBlockInlineScanner{shareReferenceLabels: shareReferenceLabels{source: source, root: root}}
	referenceClosers := shareReferenceClosers(source, rawRanges, &destinations)
	rawHTMLBrackets := shareRawHTMLBrackets(source, rawRanges)
	labels := shareReferenceLabels{source: source, root: root}
	for i := 0; i < len(source); {
		for rawIndex < len(rawRanges) && i >= rawRanges[rawIndex].end {
			rawIndex++
		}
		if rawIndex < len(rawRanges) && i >= rawRanges[rawIndex].start {
			i = rawRanges[rawIndex].end
			// 行内代码和 HTML 可以位于链接标签中；块级区域则中断标签。
			if rawRanges[rawIndex].breaksBracketStack {
				stack = nil
			}
			continue
		}
		switch source[i] {
		case '\\':
			i += min(2, len(source)-i)
		case '\n':
			if shareBlankLineAt(source, i) {
				stack = nil
			}
			i++
		case '<':
			if next := shareAutoLinkEnd(source, i); next > i {
				inlineMarkup = append(inlineMarkup, shareReferenceUse{start: i, end: next, labelStart: i + 1, labelEnd: next - 1})
				i = next
			} else {
				i++
			}
		case '!':
			// 转义的 ! 已由反斜杠分支跳过，只有真正的 ![ 才是图片。
			if i+1 < len(source) && source[i+1] == '[' {
				stack = append(stack, bracket{i, i + 2})
				i += 2
			} else {
				i++
			}
		case '[':
			stack = append(stack, bracket{i, i + 1})
			i++
		case ']':
			if len(stack) == 0 {
				i++
				continue
			}
			open := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			brackets = append(brackets, shareSourceRange{start: open.start, end: i + 1})
			labelEnd := i
			useEnd := i + 1
			keyStart, keyEnd := open.labelStart, labelEnd
			if useEnd < len(source) && source[useEnd] == '(' {
				if inlineEnd := destinations.end(useEnd); inlineEnd > useEnd {
					inlineMarkup = append(inlineMarkup, shareReferenceUse{start: open.start, end: inlineEnd, labelStart: open.labelStart, labelEnd: labelEnd})
					if source[open.start] == '!' && !shareImageHasRawBrackets(brackets[len(brackets)-1], rawHTMLBrackets) {
						imageLabels = append(imageLabels, shareSourceRange{start: open.labelStart, end: labelEnd})
					}
					i = inlineEnd
					continue
				}
				// 行内地址无效时，[标签] 仍可能是快捷引用；继续按标签
				// 查找定义，保留后面的原文以及外层链接失效处理。
				if source[open.start] == '!' {
					// 前端的图片解析失败后会保留 !，再从 [ 开始尝试链接。
					open.start++
					brackets[len(brackets)-1].start = open.start
				}
			}
			if useEnd < len(source) && source[useEnd] == '[' {
				if close, closed := referenceClosers[useEnd]; closed {
					if close > useEnd+1 {
						keyStart, keyEnd = useEnd+1, close
					}
					useEnd = close + 1
				}
				// 未闭合后缀回退到快捷引用；闭合但无效的标签不能回退。
				// 预先配对也能区分 [x][[broken 与 [x][[closed]]，无需重复扫描。
			}
			bracketIndex := sort.SearchInts(referenceBrackets, keyStart)
			if bracketIndex < len(referenceBrackets) && referenceBrackets[bracketIndex] < keyEnd {
				i++
				continue
			}
			label, ok := labels.value(keyStart, keyEnd)
			if !ok {
				i++
				continue
			}
			key := util.ToLinkReference(label)
			if _, ok := fullContext.Reference(key); ok {
				use := shareReferenceUse{open.start, useEnd, open.labelStart, labelEnd, key}
				if source[open.start] == '!' && !shareImageHasRawBrackets(brackets[len(brackets)-1], rawHTMLBrackets) {
					imageLabels = append(imageLabels, shareSourceRange{start: open.labelStart, end: labelEnd})
					referenceImages = append(referenceImages, use)
				}
				uses = append(uses, use)
				if open.start < end && useEnd > end {
					end = open.start
				}
				// [id] 已属于这次引用，不能再次当成独立快捷链接。
				i = useEnd
				continue
			}
			i++
		default:
			i++
		}
	}
	if len(uses) == 0 {
		return string(source[:end])
	}
	if end != previewEnd {
		previewContext = parser.NewContext()
		sharePreviewParser.Parse(text.NewReader(source[:end]), parser.WithContext(previewContext))
	}
	visibleReference := func(use shareReferenceUse) bool {
		original, _ := fullContext.Reference(use.key)
		visible, ok := previewContext.Reference(use.key)
		return ok && bytes.Equal(visible.Destination(), original.Destination()) && bytes.Equal(visible.Title(), original.Title())
	}
	var removedImageLabels []shareSourceRange
	for _, image := range referenceImages {
		if image.end <= end && !visibleReference(image) {
			removedImageLabels = append(removedImageLabels, shareSourceRange{start: image.labelStart, end: image.labelEnd})
		}
	}
	removedImageLabels = shareMergeSourceRanges(removedImageLabels)
	type edit struct {
		start, end int
		value      string
	}
	var edits []edit
	stripMarkup := func(use shareReferenceUse) {
		edits = append(edits, edit{use.start, use.labelStart, ""}, edit{use.labelEnd, use.end, ""})
	}
	var missingLinks []shareReferenceUse
	imageLabels = shareMergeSourceRanges(imageLabels)
	missingUseStarts := make(map[int]bool)
	referenceEnds := make(map[int]int)
	for _, use := range uses {
		if use.end > end {
			continue
		}
		referenceEnds[use.start] = use.end
		if visibleReference(use) && !shareRangesContain(removedImageLabels, use.start, use.end) {
			continue
		}
		// 定义可能在地址或标题中间被截断；同名但内容不完整的引用
		// 也应退化为文字，不能让链接或图片使用截短后的 URL。
		// 只去掉引用标记的两端，保留标签内部的源码坐标，供嵌套引用继续改写。
		stripMarkup(use)
		missingUseStarts[use.start] = true
		if source[use.start] != '!' {
			if !shareRangesContain(imageLabels, use.start, use.end) {
				// 图片替代文字只渲染标签文本，里面的引用不会形成内层链接。
				missingLinks = append(missingLinks, use)
			}
		}
	}
	// 图片退化为替代文字后，其中原本不可点击的行内链接、自动链接和
	// 嵌套图片也只保留标签，避免它们变成新的链接或破坏外层正常链接。
	for _, use := range inlineMarkup {
		if use.end <= end && shareRangesContain(removedImageLabels, use.start, use.end) {
			stripMarkup(use)
		}
	}
	// 内层链接失去定义后，原本无效的外层链接或图片可能重新生效。
	// 这些嵌套语法保守地退化为可读标签与原有的可见地址。
	sort.Slice(missingLinks, func(i, j int) bool { return missingLinks[i].end < missingLinks[j].end })
	maxStart := make([]int, len(missingLinks))
	for i, use := range missingLinks {
		maxStart[i] = use.start
		if i > 0 {
			maxStart[i] = max(maxStart[i], maxStart[i-1])
		}
	}
	for _, bracket := range brackets {
		if bracket.end > end || missingUseStarts[bracket.start] {
			continue
		}
		count := sort.Search(len(missingLinks), func(i int) bool { return missingLinks[i].end > bracket.end })
		if count == 0 || maxStart[count-1] <= bracket.start {
			continue
		}
		if source[bracket.start] == '!' && !shareImageHasRawBrackets(bracket, rawHTMLBrackets) {
			continue
		}
		closing := " "
		referenceEnd := referenceEnds[bracket.start]
		if referenceEnd > bracket.end {
			closing = ""
		}
		openerEnd := bracket.start + 1
		if source[bracket.start] == '!' {
			openerEnd++
		}
		edits = append(edits,
			edit{bracket.start, openerEnd, ""},
			edit{bracket.end - 1, bracket.end, closing},
		)
		// [标签][id] 失去外层方括号后，[id] 也可能独立成为快捷引用。
		if referenceEnd > bracket.end {
			edits = append(edits, edit{bracket.end, referenceEnd, ""})
		}
	}
	sort.Slice(edits, func(i, j int) bool {
		if edits[i].start == edits[j].start {
			return edits[i].end > edits[j].end
		}
		return edits[i].start < edits[j].start
	})
	var result strings.Builder
	last := 0
	for _, current := range edits {
		if current.start < last {
			continue
		}
		result.Write(source[last:current.start])
		result.WriteString(current.value)
		last = current.end
	}
	result.Write(source[last:end])
	return result.String()
}

// 前端的 Markdown 解析器可能把图片替代文字里的 HTML 属性方括号识别成图片边界。
// 这种图片在隐藏内层引用后只能作为普通文字展示，避免突然出现链接。
func shareImageHasRawBrackets(image shareSourceRange, brackets []int) bool {
	index := sort.SearchInts(brackets, image.start)
	return index < len(brackets) && brackets[index] < image.end
}

// rawRanges 已排序且不重叠。每个 HTML 字节只检查一次，嵌套图片
// 也只查询方括号的位置，不会反复扫描它们之前或内部的 HTML。
func shareRawHTMLBrackets(source []byte, rawRanges []shareSourceRange) []int {
	var brackets []int
	for _, raw := range rawRanges {
		if !raw.inlineHTML {
			continue
		}
		for i := raw.start; i < raw.end; i++ {
			if source[i] == '[' || source[i] == ']' {
				brackets = append(brackets, i)
			}
		}
	}
	return brackets
}

// 引用定义（含跨行标签、地址和标题）不留在 Goldmark AST 的正文行中。
// 连续的未渲染行作为一个区间，避免截断续行后把半截定义变为普通正文。
func shareUnrenderedReferenceRanges(root ast.Node, source []byte) []shareSourceRange {
	lineStarts := []int{0}
	for i, value := range source {
		if value == '\n' && i+1 < len(source) {
			lineStarts = append(lineStarts, i+1)
		}
	}
	covered := make([]bool, len(lineStarts))
	_ = ast.Walk(root, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering || node.Type() != ast.TypeBlock {
			return ast.WalkContinue, nil
		}
		lines := node.Lines()
		for i := 0; i < lines.Len(); i++ {
			segment := lines.At(i)
			line := sort.Search(len(lineStarts), func(j int) bool { return lineStarts[j] > segment.Start }) - 1
			for line >= 0 && line < len(lineStarts) && lineStarts[line] < segment.Stop {
				covered[line] = true
				line++
			}
		}
		return ast.WalkContinue, nil
	})
	lineEnd := func(i int) int {
		end := len(source)
		if i+1 < len(lineStarts) {
			end = lineStarts[i+1]
		}
		return end
	}
	var ranges []shareSourceRange
	for i := 0; i < len(lineStarts); {
		start, end := lineStarts[i], lineEnd(i)
		if covered[i] || util.IsBlank(source[start:end]) {
			i++
			continue
		}
		hasBrackets := false
		for i < len(lineStarts) && !covered[i] && !util.IsBlank(source[lineStarts[i]:lineEnd(i)]) {
			end = lineEnd(i)
			hasBrackets = hasBrackets || bytes.IndexAny(source[lineStarts[i]:end], "[]") >= 0
			i++
		}
		if hasBrackets {
			ranges = append(ranges, shareSourceRange{start: start, end: end, breaksBracketStack: true})
		}
	}
	return ranges
}

// Goldmark 的源码片段告诉扫描器哪些文字处于代码或 HTML 中，
// 并区分会中断链接标签的块级区域与不会中断它的行内区域。
// 没有这些语法的普通段落不需要构造 AST，避免大篇幅纯文本增加解析开销。
func shareRawMarkdownRanges(source []byte) []shareSourceRange {
	if bytes.IndexAny(source, "`~<\t") < 0 && !bytes.Contains(source, []byte("    ")) {
		return nil
	}
	root := sharePreviewParser.Parse(text.NewReader(source))
	var ranges []shareSourceRange
	add := func(start, end int, breaksBracketStack, inlineHTML bool) {
		if start >= 0 && end > start && end <= len(source) {
			ranges = append(ranges, shareSourceRange{start: start, end: end, breaksBracketStack: breaksBracketStack, inlineHTML: inlineHTML})
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
			add(start, end, true, false)
		case ast.KindRawHTML:
			html := node.(*ast.RawHTML)
			start, end := len(source), 0
			for i := 0; i < html.Segments.Len(); i++ {
				segment := html.Segments.At(i)
				start = min(start, segment.Start)
				end = max(end, segment.Stop)
			}
			add(start, end, false, true)
		case ast.KindCodeSpan:
			start, end := len(source), 0
			for child := node.FirstChild(); child != nil; child = child.NextSibling() {
				if code, ok := child.(*ast.Text); ok {
					start = min(start, code.Segment.Start)
					end = max(end, code.Segment.Stop)
				}
			}
			add(start, end, false, false)
		}
		return ast.WalkContinue, nil
	})
	return shareMergeSourceRanges(ranges)
}

func shareMergeSourceRanges(ranges []shareSourceRange) []shareSourceRange {
	if len(ranges) < 2 {
		return ranges
	}
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].start < ranges[j].start })
	merged := ranges[:1]
	for _, current := range ranges[1:] {
		last := &merged[len(merged)-1]
		if current.start <= last.end {
			last.end = max(last.end, current.end)
			last.breaksBracketStack = last.breaksBracketStack || current.breaksBracketStack
			last.inlineHTML = last.inlineHTML || current.inlineHTML
		} else {
			merged = append(merged, current)
		}
	}
	return merged
}

// 块级代码和 HTML 会中断链接；行内代码和 HTML 则需跳过内容并保留链接起点。
func shareSafeInlineCutoff(source []byte, cutoff int, rawRanges []shareSourceRange) int {
	start, stop := 0, len(source)
	htmlStart := cutoff
	for _, raw := range rawRanges {
		if raw.inlineHTML && cutoff > raw.start && cutoff < raw.end {
			htmlStart = raw.start
		}
		if !raw.breaksBracketStack {
			continue
		}
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
	return min(htmlStart, shareSafeMarkupCutoff(source[:stop], cutoff, start, rawRanges))
}

// 单次扫描当前行内区域，保留跨过 cutoff 的图片、链接和自动链接的完整边界。
func shareSafeMarkupCutoff(source []byte, cutoff, start int, rawRanges []shareSourceRange) int {
	end := cutoff
	var starts []int
	destinations := shareBlockInlineScanner{shareReferenceLabels: shareReferenceLabels{source: source}}
	rawIndex := sort.Search(len(rawRanges), func(i int) bool { return rawRanges[i].end > start })
	for i := start; i < len(source); {
		for rawIndex < len(rawRanges) && i >= rawRanges[rawIndex].end {
			rawIndex++
		}
		if rawIndex < len(rawRanges) && i >= rawRanges[rawIndex].start {
			i = min(rawRanges[rawIndex].end, len(source))
			continue
		}
		switch source[i] {
		case '\\':
			i += min(2, len(source)-i)
		case '\n':
			if shareBlankLineAt(source, i) {
				starts = nil
			}
			i++
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
			if inlineEnd := destinations.end(i + 1); inlineEnd > i+1 {
				if start < cutoff && inlineEnd > cutoff && start < end {
					end = start
				}
				i = inlineEnd
			} else {
				i++
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

func shareBlankLineAt(source []byte, newline int) bool {
	if newline >= len(source) || source[newline] != '\n' {
		return false
	}
	for i := newline + 1; i < len(source); i++ {
		switch source[i] {
		case ' ', '\t', '\r':
			continue
		case '\n':
			return true
		default:
			return false
		}
	}
	return false
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
