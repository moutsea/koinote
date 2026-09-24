package server

import "sort"

// 每个链接独立判断；地址后缀、分隔符和标题结果按源码位置复用。
// 这样坏链接不会跳过紧邻的正常链接，大量未闭合地址也不会重复扫描全文。
type shareInlineScanner struct {
	source       []byte
	bareEnds     []int
	bareDepth    []uint8
	angleStops   []int
	doubleQuotes []int
	singleQuotes []int
	parens       []int
	blankLines   []int
	tailEnds     map[int]int
}

func (s *shareInlineScanner) index() {
	if s.bareEnds != nil {
		return
	}
	source := s.source
	s.bareEnds = make([]int, len(source)+1)
	s.bareDepth = make([]uint8, len(source)+1)
	s.bareEnds[len(source)] = len(source)
	for i := len(source) - 1; i >= 0; i-- {
		next := s.bareEnds[i+1]
		depth := s.bareDepth[i+1]
		switch {
		case source[i] <= ' ' && source[i] != 0, source[i] == 0x7f, source[i] == ')':
			next = i
			depth = 0
		case source[i] == '\\' && i+1 < len(source):
			if source[i+1] == ' ' {
				next, depth = i, 0
			} else {
				next, depth = s.bareEnds[i+2], s.bareDepth[i+2]
			}
		case source[i] == '(':
			if next >= 0 && next < len(source) && source[next] == ')' {
				depth = uint8(min(33, max(int(depth)+1, int(s.bareDepth[next+1]))))
				next = s.bareEnds[next+1]
			} else {
				next = -1 // 空白或末尾前仍有不配对的左括号。
			}
		}
		s.bareEnds[i] = next
		s.bareDepth[i] = depth
	}
	escaped := false
	for i, value := range source {
		// 标题即使使用反斜杠换行，也不能跨过空行。
		if value == '\n' && shareBlankLineAt(source, i) {
			s.blankLines = append(s.blankLines, i)
		}
		if escaped {
			escaped = false
			continue
		}
		switch value {
		case '\\':
			escaped = true
		case '<', '>', '\n':
			s.angleStops = append(s.angleStops, i)
		case '"':
			s.doubleQuotes = append(s.doubleQuotes, i)
		case '\'':
			s.singleQuotes = append(s.singleQuotes, i)
		case '(', ')':
			s.parens = append(s.parens, i)
		}
	}
	s.tailEnds = make(map[int]int)
}

func (s *shareInlineScanner) skipSpaces(i int) int {
	for i < len(s.source) && shareMarkdownSpace(s.source[i]) {
		if s.source[i] == '\n' && shareBlankLineAt(s.source, i) {
			return -1
		}
		i++
	}
	return i
}

func (s *shareInlineScanner) end(open int) int {
	i := s.skipSpaces(open + 1)
	if i < 0 || i == len(s.source) {
		return 0
	}
	if s.source[i] == ')' {
		return i + 1
	}
	destinationStart, destinationEnd, i := s.destination(i)
	if i < 0 {
		return 0
	}
	end, ok := s.tailEnds[i]
	if !ok {
		end = s.tailEnd(i)
		s.tailEnds[i] = end
	}
	if end > 0 && !shareAllowedLinkDestination(s.source[destinationStart:destinationEnd]) {
		return 0
	}
	return end
}

// 行内链接和引用定义共用地址语法；返回内容范围及地址标记后的坐标。
func (s *shareInlineScanner) destination(i int) (int, int, int) {
	if i < 0 || i >= len(s.source) {
		return 0, 0, -1
	}
	s.index()
	if s.source[i] == '<' {
		next := sort.SearchInts(s.angleStops, i+1)
		if next == len(s.angleStops) || s.source[s.angleStops[next]] != '>' {
			return 0, 0, -1
		}
		return i + 1, s.angleStops[next], s.angleStops[next] + 1
	}
	end := s.bareEnds[i]
	if end < 0 || end == i || s.bareDepth[i] > 32 {
		return 0, 0, -1
	}
	return i, end, end
}

func (s *shareInlineScanner) tailEnd(start int) int {
	i := s.skipSpaces(start)
	if i < 0 || i == len(s.source) {
		return 0
	}
	if s.source[i] == ')' {
		return i + 1
	}
	if i == start {
		return 0 // 标题必须与地址之间有空白。
	}
	close := s.titleEnd(i)
	if close == 0 {
		return 0
	}
	i = s.skipSpaces(close)
	if i >= 0 && i < len(s.source) && s.source[i] == ')' {
		return i + 1
	}
	return 0
}

func (s *shareInlineScanner) titleEnd(i int) int {
	if i < 0 || i >= len(s.source) {
		return 0
	}
	s.index()
	var delimiters []int
	closer := s.source[i]
	switch closer {
	case '"':
		delimiters = s.doubleQuotes
	case '\'':
		delimiters = s.singleQuotes
	case '(':
		delimiters = s.parens
		closer = ')'
	default:
		return 0
	}
	next := sort.SearchInts(delimiters, i+1)
	if next == len(delimiters) || s.source[delimiters[next]] != closer {
		return 0
	}
	close := delimiters[next]
	blank := sort.SearchInts(s.blankLines, i+1)
	if blank < len(s.blankLines) && s.blankLines[blank] < close {
		return 0
	}
	return close + 1
}

// 单个候选的入口；全文扫描时复用同一个 shareInlineScanner。
func shareInlineDestinationEnd(source []byte, open int) int {
	scanner := shareInlineScanner{source: source}
	return scanner.end(open)
}
