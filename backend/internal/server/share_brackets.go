package server

import "sort"

// ranges 已合并、排序，查找不随嵌套深度反复扫描。
func shareRangesContain(ranges []shareSourceRange, start, end int) bool {
	index := sort.Search(len(ranges), func(i int) bool { return ranges[i].end >= end })
	return index < len(ranges) && ranges[index].start <= start
}

// 引用后缀的配对与行内解析共用代码区间和地址扫描器。代码、自动链接、
// 已解析地址中的方括号不参与配对；源码方括号索引仍单独用于验证引用 ID。
func shareReferenceClosers(source []byte, rawRanges []shareSourceRange, destinations *shareBlockInlineScanner) map[int]int {
	closers := make(map[int]int)
	var starts []int
	rawIndex := 0
	for i := 0; i < len(source); {
		for rawIndex < len(rawRanges) && i >= rawRanges[rawIndex].end {
			rawIndex++
		}
		if rawIndex < len(rawRanges) && i >= rawRanges[rawIndex].start && !rawRanges[rawIndex].inlineHTML {
			i = rawRanges[rawIndex].end
			if rawRanges[rawIndex].breaksBracketStack {
				starts = nil
			}
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
		case '<':
			if next := shareAutoLinkEnd(source, i); next > i {
				i = next
			} else {
				i++
			}
		case '[':
			starts = append(starts, i)
			i++
		case ']':
			if len(starts) > 0 {
				closers[starts[len(starts)-1]] = i
				starts = starts[:len(starts)-1]
				if i+1 < len(source) && source[i+1] == '(' {
					if end := destinations.end(i + 1); end > i+1 {
						i = end
						continue
					}
				}
			}
			i++
		default:
			i++
		}
	}
	return closers
}
