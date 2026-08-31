package main

import (
	"bufio"
	"bytes"
	"errors"
	"strings"
	"testing"
)

var errUnexpectedTunnelRead = errors.New("unexpected read past buffered tunnel data")

type oneChunkReader struct {
	chunk []byte
	reads int
}

func (r *oneChunkReader) Read(destination []byte) (int, error) {
	r.reads++
	if r.reads > 1 {
		return 0, errUnexpectedTunnelRead
	}
	return copy(destination, r.chunk), nil
}

func TestValidateTarget(t *testing.T) {
	valid := []struct {
		method string
		target string
	}{
		{"CONNECT", "api.weixin.qq.com:443"},
		{"CONNECT", "API.WEIXIN.QQ.COM:443"},
	}
	for _, test := range valid {
		if err := validateTarget(test.method, test.target); err != nil {
			t.Errorf("validateTarget(%q, %q) = %v", test.method, test.target, err)
		}
	}
	invalid := []struct {
		method string
		target string
	}{
		{"GET", "api.weixin.qq.com:443"},
		{"CONNECT", "api.weixin.qq.com:80"},
		{"CONNECT", "169.254.169.254:443"},
		{"CONNECT", "api.weixin.qq.com:443.evil.example"},
	}
	for _, test := range invalid {
		if err := validateTarget(test.method, test.target); err == nil {
			t.Errorf("validateTarget(%q, %q) unexpectedly succeeded", test.method, test.target)
		}
	}
}

func TestReadConnectRequest(t *testing.T) {
	source := &oneChunkReader{chunk: []byte(
		"CONNECT api.weixin.qq.com:443 HTTP/1.1\r\nHost: api.weixin.qq.com:443\r\n\r\nTLS",
	)}
	reader := bufio.NewReader(source)
	request, err := readConnectRequest(reader)
	if err != nil {
		t.Fatalf("readConnectRequest() error = %v", err)
	}
	if request.method != "CONNECT" || request.target != "api.weixin.qq.com:443" {
		t.Fatalf("readConnectRequest() = %#v", request)
	}
	var forwarded bytes.Buffer
	if err := forwardBufferedTunnelData(&forwarded, reader); err != nil {
		t.Fatalf("forward buffered tunnel data: %v", err)
	}
	if forwarded.String() != "TLS" || source.reads != 1 {
		t.Fatalf("buffered tunnel data=%q source reads=%d", forwarded.String(), source.reads)
	}
}

func TestReadConnectRequestRejectsOversizedLine(t *testing.T) {
	line := "CONNECT " + strings.Repeat("x", maxConnectHeader) + " HTTP/1.1\r\n"
	if _, err := readConnectRequest(bufio.NewReader(strings.NewReader(line))); err == nil {
		t.Fatal("readConnectRequest() accepted an oversized line")
	}
}
