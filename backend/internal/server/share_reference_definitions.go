package server

import (
	"bytes"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// Goldmark 默认会移除前端拒绝的引用定义。必须在段落转换时验证，
// 让无效定义保留为正文，且不占用后续同名有效定义的键。
type shareReferenceTransformer struct{}

func (shareReferenceTransformer) Transform(node *ast.Paragraph, reader text.Reader, pc parser.Context) {
	lines := node.Lines()
	if originals, ok := pc.Get(shareParagraphLinesKey).(map[ast.Node]*text.Segments); ok {
		if original := originals[node]; original != nil {
			lines = original
			node.SetLines(lines)
			delete(originals, node)
		}
	}
	if lines.Len() == 0 {
		return
	}
	first := lines.At(0)
	value := first.Value(reader.Source())
	_, indent := util.IndentWidth(value, 0)
	if indent >= len(value) || value[indent] != '[' {
		return
	}
	scanner := shareInlineScanner{source: lines.Value(reader.Source())}
	end, consumed, count := 0, 0, 0
	for {
		if count == lines.Len() {
			break
		}
		reference, next := scanner.referenceDefinition(end, shareSegmentColumn(reader.Source(), lines.At(count)))
		if reference == nil {
			// 去掉定义后，原本不能中断段落的缩进代码成为独立块。
			// 消费代码块后继续识别定义，不能让它阻断后续同级引用。
			if end == 0 || count == lines.Len() {
				break
			}
			var code *ast.CodeBlock
			for count < lines.Len() {
				segment := lines.At(count)
				value := segment.Value(reader.Source())
				position, padding := util.IndentPosition(value, shareSegmentColumn(reader.Source(), segment), 4)
				if position < 0 {
					break
				}
				if code == nil {
					code = ast.NewCodeBlock()
					code.SetBlankPreviousLines(node.HasBlankPreviousLines())
					node.Parent().InsertBefore(node.Parent(), node, code)
				}
				segment.Start += max(0, position-segment.Padding)
				segment.Padding = max(padding, segment.Padding-position)
				segment.ForceNewline = true
				code.Lines().Append(segment)
				consumed += len(value)
				count++
			}
			if code == nil {
				break
			}
			end = consumed
			continue
		}
		pc.AddReference(reference)
		end = next
		for count < lines.Len() && consumed < end {
			segment := lines.At(count)
			consumed += len(segment.Value(reader.Source()))
			count++
		}
	}
	if end == 0 {
		return
	}
	lines.SetSliced(count, lines.Len())
	if lines.Len() == 0 {
		replacement := ast.NewTextBlock()
		replacement.SetBlankPreviousLines(node.HasBlankPreviousLines())
		node.Parent().ReplaceChild(node.Parent(), node, replacement)
	}
}

func (s *shareInlineScanner) referenceDefinition(start, column int) (parser.Reference, int) {
	source := s.source
	if start >= len(source) {
		return nil, 0
	}
	width, indent := util.IndentWidth(source[start:], column)
	i := start + indent
	if width > 3 || i >= len(source) || source[i] != '[' {
		return nil, 0
	}
	labelStart := i + 1
	i = labelStart
	for i < len(source) && source[i] != ']' {
		if source[i] == '[' || source[i] == '\n' && shareBlankLineAt(source, i) {
			return nil, 0
		}
		if source[i] == '\\' && i+1 < len(source) {
			i++
		}
		i++
	}
	if i+1 >= len(source) || source[i+1] != ':' || util.IsBlank(source[labelStart:i]) {
		return nil, 0
	}
	label := source[labelStart:i]
	destinationStart, destinationEnd, tail := s.referenceDestination(s.skipSpaces(i + 2))
	if tail < 0 || !shareAllowedLinkDestination(source[destinationStart:destinationEnd]) {
		return nil, 0
	}
	// 标题失败时仅可回退到完整的地址行，不能吞掉后续普通正文。
	end := s.referenceLineEnd(tail)
	var title []byte
	titleStart := s.skipSpaces(tail)
	if titleStart > tail {
		if titleEnd := s.titleEnd(titleStart); titleEnd > 0 {
			if complete := s.referenceLineEnd(titleEnd); complete > 0 {
				title = source[titleStart+1 : titleEnd-1]
				end = complete
			} else if titleEnd == titleStart+2 {
				// 前端仅对非空标题的尾部错误回退；空标题后有正文时整条定义失败。
				return nil, 0
			}
		}
	}
	if end == 0 {
		return nil, 0
	}
	// Markdown-it 的引用定义规则去掉每条续行的缩进；标题内容也遵循此规则。
	if bytes.ContainsAny(title, "\r\n") {
		title = bytes.ReplaceAll(title, []byte("\r\n"), []byte("\n"))
		title = bytes.ReplaceAll(title, []byte("\r"), []byte("\n"))
		lines := bytes.Split(title, []byte("\n"))
		for i := 1; i < len(lines); i++ {
			lines[i] = bytes.TrimLeft(lines[i], " \t")
		}
		title = bytes.Join(lines, []byte("\n"))
	}
	return parser.NewReference(label, source[destinationStart:destinationEnd], title), end
}

// 制表符按原始物理列展开；引用块和列表前缀会改变下一个 tab stop。
func shareSegmentColumn(source []byte, segment text.Segment) int {
	start := bytes.LastIndexByte(source[:segment.Start], '\n') + 1
	column := 0
	for _, value := range source[start:segment.Start] {
		if value == '\t' {
			column += util.TabWidth(column)
		} else {
			column++
		}
	}
	return column - segment.Padding
}

func (s *shareInlineScanner) referenceDestination(start int) (int, int, int) {
	if start < 0 || start >= len(s.source) {
		return 0, 0, -1
	}
	// 引用规则一次只将地址所在行交给 parseLinkDestination；反斜杠
	// 也不能把地址延伸到下一行。行内链接才允许扫描整个行内区域。
	stop := len(s.source)
	if newline := bytes.IndexByte(s.source[start:], '\n'); newline >= 0 {
		stop = start + newline
	}
	if stop > start && s.source[stop-1] == '\r' {
		stop--
	}
	line := shareInlineScanner{source: s.source[start:stop]}
	from, to, end := line.destination(0)
	if end < 0 {
		return 0, 0, -1
	}
	return start + from, start + to, start + end
}

func (s *shareInlineScanner) referenceLineEnd(i int) int {
	for i < len(s.source) && (s.source[i] == ' ' || s.source[i] == '\t' || s.source[i] == '\r') {
		i++
	}
	if i == len(s.source) {
		return i
	}
	if s.source[i] == '\n' {
		return i + 1
	}
	return 0
}
