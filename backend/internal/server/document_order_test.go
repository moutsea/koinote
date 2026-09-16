package server

import "testing"

func TestSameDocumentIDs(t *testing.T) {
	tests := []struct {
		name        string
		left, right []string
		want        bool
	}{
		{name: "same set in different order", left: []string{"a", "b", "c"}, right: []string{"c", "a", "b"}, want: true},
		{name: "missing id", left: []string{"a", "b"}, right: []string{"a", "c"}, want: false},
		{name: "duplicate id", left: []string{"a", "b"}, right: []string{"a", "a"}, want: false},
		{name: "different lengths", left: []string{"a"}, right: []string{"a", "b"}, want: false},
		{name: "empty", left: nil, right: nil, want: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := sameDocumentIDs(test.left, test.right); got != test.want {
				t.Fatalf("sameDocumentIDs(%v, %v) = %v, want %v", test.left, test.right, got, test.want)
			}
		})
	}
}
