package server

import (
	"sort"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

var sharePreviewParser = newShareMarkdownParser(shareReferenceTransformer{})
var shareLinkDestinationsKey = parser.NewContextKey()
var shareParagraphLinesKey = parser.NewContextKey()

func newShareMarkdownParser(references ...parser.ParagraphTransformer) parser.Parser {
	inlines := parser.DefaultInlineParsers()
	for i, inline := range inlines {
		if inline.Value == parser.NewLinkParser() {
			inlines[i].Value = shareLinkParser{InlineParser: parser.NewLinkParser()}
		}
	}
	transformers := parser.DefaultParagraphTransformers()
	blocks := parser.DefaultBlockParsers()
	if len(references) > 0 {
		transformers = []util.PrioritizedValue{util.Prioritized(references[0], 100)}
		for i, block := range blocks {
			if block.Value == parser.NewParagraphParser() {
				blocks[i].Value = shareParagraphParser{BlockParser: parser.NewParagraphParser()}
			}
		}
	}
	return parser.NewParser(
		parser.WithBlockParsers(blocks...),
		parser.WithInlineParsers(inlines...),
		parser.WithParagraphTransformers(transformers...),
	)
}

type shareParagraphParser struct{ parser.BlockParser }

func (p shareParagraphParser) Close(node ast.Node, reader text.Reader, pc parser.Context) {
	// Setext 标题会先 Close 再转换段落；原版 Close 会丢掉所有续行缩进。
	// 保留转换前的片段，引用定义之后的四空格代码块仍需按原缩进判定。
	if lines := node.Lines(); lines.Len() > 0 {
		originals, _ := pc.Get(shareParagraphLinesKey).(map[ast.Node]*text.Segments)
		if originals == nil {
			originals = make(map[ast.Node]*text.Segments)
			pc.Set(shareParagraphLinesKey, originals)
		}
		copy := text.NewSegments()
		copy.AppendAll(lines.Sliced(0, lines.Len()))
		originals[node] = copy
	}
	p.BlockParser.Close(node, reader, pc)
}

type shareLinkParser struct{ parser.InlineParser }

func (p shareLinkParser) Parse(parent ast.Node, block text.Reader, pc parser.Context) ast.Node {
	if block.Peek() != ']' {
		return p.InlineParser.Parse(parent, block, pc)
	}
	_, labelEnd := block.Position()
	reader := &shareLinkReader{Reader: block, context: pc, labelEnd: labelEnd.Start, destinationStart: -1, destinationEnd: -1}
	node := p.InlineParser.Parse(parent, reader, pc)
	_, position := block.Position()
	if reader.destinationEnd >= 0 && position.Start <= reader.destinationStart {
		// 原解析器已回退到 ] 后面，说明地址后的标题/右括号不合法。
		// 后续候选若共享同一个地址结束位置，结果也相同，无需重新扫描。
		if reader.angle {
			reader.destinations.failedAngles[reader.destinationEnd] = true
		} else {
			reader.destinations.failedBare[reader.destinationEnd] = true
		}
	}
	return node
}

func (p shareLinkParser) CloseBlock(parent ast.Node, block text.Reader, pc parser.Context) {
	p.InlineParser.(parser.CloseBlocker).CloseBlock(parent, block, pc)
}

// 只包装链接解析器的读取，不修改源码、坐标或其他 Markdown 解析器。
// Goldmark 1.7.13 会为每个未闭合地址重新扫描同一段源码；索引结束位置后，
// 可确定失败的地址交给它一个空候选，仍由它清理标签栈并回退到引用链接。
type shareLinkReader struct {
	text.Reader
	context                          parser.Context
	destinations                     *shareLinkDestinations
	labelEnd                         int
	destinationStart, destinationEnd int
	angle                            bool
}

type shareLinkDestinations struct {
	closers      []int
	bareEnds     []int
	failedAngles map[int]bool
	failedBare   map[int]bool
}

func newShareLinkDestinations(source []byte) *shareLinkDestinations {
	index := &shareLinkDestinations{
		bareEnds:     make([]int, len(source)+1),
		failedAngles: make(map[int]bool),
		failedBare:   make(map[int]bool),
	}
	escaped := make([]bool, len(source))
	for i := 0; i < len(source); i++ {
		if source[i] == '\\' && i+1 < len(source) && util.IsPunct(source[i+1]) {
			i++
			escaped[i] = true
		} else if source[i] == '>' {
			index.closers = append(index.closers, i)
		}
	}
	// 从后向前复用已计算的后缀；平衡的括号对一步跳过。
	// 与 Goldmark 一致，在首个空白、行尾或不配对的右括号处结束。
	index.bareEnds[len(source)] = len(source)
	for i := len(source) - 1; i >= 0; i-- {
		next := index.bareEnds[i+1]
		switch {
		case util.IsSpace(source[i]), source[i] == ')' && !escaped[i]:
			next = i
		case source[i] == '(' && !escaped[i]:
			if next < len(source) && source[next] == ')' && !escaped[next] {
				next = index.bareEnds[next+1]
			}
		}
		index.bareEnds[i] = next
	}
	return index
}

func (r *shareLinkReader) PeekLine() ([]byte, text.Segment) {
	line, segment := r.Reader.PeekLine()
	// 首次读取是标签的 ]，不是链接地址，必须原样交给链接解析器。
	if len(line) == 0 || segment.Start <= r.labelEnd {
		return line, segment
	}
	index, _ := r.context.Get(shareLinkDestinationsKey).(*shareLinkDestinations)
	if index == nil {
		index = newShareLinkDestinations(r.Source())
		r.context.Set(shareLinkDestinationsKey, index)
	}
	r.destinations = index
	r.destinationStart = segment.Start
	if line[0] != '<' {
		r.destinationEnd = min(index.bareEnds[segment.Start], segment.Stop)
		if index.failedBare[r.destinationEnd] {
			return line[:0], segment
		}
		return line, segment
	}
	r.angle = true
	next := sort.SearchInts(index.closers, segment.Start+1)
	if next == len(index.closers) || index.closers[next] >= segment.Stop {
		return line[:1], segment
	}
	r.destinationEnd = index.closers[next]
	if index.failedAngles[r.destinationEnd] {
		return line[:1], segment
	}
	return line, segment
}
