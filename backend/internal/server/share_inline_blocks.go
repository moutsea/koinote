package server

import "sort"

// 只为查询到的正文块构建行内文本；每个块和每个地址后缀最多索引一次。
// 映射保留原文坐标，容器前缀不会进入地址或标题，也不会跨正文块拼接。
type shareBlockInlineScanner struct {
	shareReferenceLabels
	scanners map[int]*shareMappedInlineScanner
}

type shareMappedInlineScanner struct {
	shareInlineScanner
	starts []int
}

func (s *shareBlockInlineScanner) end(open int) int {
	s.index()
	blockIndex := sort.Search(len(s.blocks), func(i int) bool { return s.blocks[i].end > open })
	if blockIndex == len(s.blocks) || open < s.blocks[blockIndex].start {
		return 0
	}
	lines := s.blocks[blockIndex].lines
	line := sort.Search(lines.Len(), func(i int) bool { return lines.At(i).Stop > open })
	segment := lines.At(line)
	if open < segment.Start {
		return 0
	}
	if s.scanners == nil {
		s.scanners = make(map[int]*shareMappedInlineScanner)
	}
	scanner := s.scanners[blockIndex]
	if scanner == nil {
		scanner = &shareMappedInlineScanner{}
		for i := 0; i < lines.Len(); i++ {
			segment := lines.At(i)
			scanner.starts = append(scanner.starts, len(scanner.source)+segment.Padding)
			scanner.source = append(scanner.source, segment.Value(s.source)...)
		}
		s.scanners[blockIndex] = scanner
	}
	end := scanner.end(scanner.starts[line] + open - segment.Start)
	if end == 0 {
		return 0
	}
	line = sort.Search(len(scanner.starts), func(i int) bool { return scanner.starts[i] >= end }) - 1
	return lines.At(line).Start + end - scanner.starts[line]
}
