package server

import (
	"bytes"
	"sort"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

type shareReferenceBlock struct {
	start, end int
	lines      *text.Segments
}

// 标签的源码坐标仍用于预览改写，查找引用时则只读取所属正文块的
// 行内内容；引用块的 >、列表缩进等容器前缀不属于跨行标签。
type shareReferenceLabels struct {
	source  []byte
	root    ast.Node
	blocks  []shareReferenceBlock
	indexed bool
}

func (s *shareReferenceLabels) value(start, end int) ([]byte, bool) {
	if !bytes.Contains(s.source[start:end], []byte("\n")) {
		return s.source[start:end], true
	}
	s.index()
	index := sort.Search(len(s.blocks), func(i int) bool { return s.blocks[i].end > start })
	if index == len(s.blocks) || start < s.blocks[index].start || end > s.blocks[index].end {
		// 即使物理行间有 > 等字符，跨越两个正文块也不能拼成引用标签。
		return nil, false
	}
	lines := s.blocks[index].lines
	line := sort.Search(lines.Len(), func(i int) bool { return lines.At(i).Stop > start })
	var label []byte
	for ; line < lines.Len(); line++ {
		segment := lines.At(line)
		if segment.Start >= end {
			break
		}
		from, to := max(start, segment.Start), min(end, segment.Stop)
		if from < to {
			label = append(label, s.source[from:to]...)
		}
	}
	return label, true
}

func (s *shareReferenceLabels) index() {
	if s.indexed {
		return
	}
	s.indexed = true
	if s.root == nil {
		s.root = sharePreviewParser.Parse(text.NewReader(s.source))
	}
	_ = ast.Walk(s.root, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering || node.Type() != ast.TypeBlock || node.IsRaw() || node.Lines().Len() == 0 {
			return ast.WalkContinue, nil
		}
		lines := node.Lines()
		s.blocks = append(s.blocks, shareReferenceBlock{
			start: lines.At(0).Start,
			end:   lines.At(lines.Len() - 1).Stop,
			lines: lines,
		})
		return ast.WalkContinue, nil
	})
	sort.Slice(s.blocks, func(i, j int) bool { return s.blocks[i].start < s.blocks[j].start })
}
