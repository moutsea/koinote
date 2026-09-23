package main

import (
	"bufio"
	"bytes"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

var errUnexpectedTunnelRead = errors.New("unexpected read past buffered tunnel data")

func TestIdleTimeoutKeepsActiveUploadAndPendingResponseAlive(t *testing.T) {
	client, peer := net.Pipe()
	defer client.Close()
	defer peer.Close()
	conn := newIdleTimeoutConn(client, 300*time.Millisecond)
	peerDone := make(chan error, 1)
	go func() {
		_, err := io.CopyN(io.Discard, peer, 10)
		if err == nil {
			_, err = peer.Write([]byte{1})
		}
		peerDone <- err
	}()
	readDone := make(chan error, 1)
	go func() {
		_, err := io.ReadFull(conn, make([]byte, 1))
		readDone <- err
	}()
	for index := 0; index < 10; index++ {
		time.Sleep(50 * time.Millisecond)
		if _, err := conn.Write([]byte{1}); err != nil {
			t.Fatalf("active upload expired: %v", err)
		}
	}
	if err := <-readDone; err != nil {
		t.Fatalf("response reader expired during active upload: %v", err)
	}
	if err := <-peerDone; err != nil {
		t.Fatal(err)
	}
}

func TestIdleTimeoutClosesInactiveTunnel(t *testing.T) {
	client, peer := net.Pipe()
	defer client.Close()
	defer peer.Close()
	conn := newIdleTimeoutConn(client, 20*time.Millisecond)
	_, err := conn.Read(make([]byte, 1))
	var networkError net.Error
	if !errors.As(err, &networkError) || !networkError.Timeout() {
		t.Fatalf("inactive connection error=%v, want timeout", err)
	}
}

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
