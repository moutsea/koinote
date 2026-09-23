package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultListenAddress  = "10.77.0.1:18080"
	allowedWechatHost     = "api.weixin.qq.com"
	allowedWechatTarget   = allowedWechatHost + ":443"
	maxConnectHeader      = 8 << 10
	connectTimeout        = 15 * time.Second
	connectionIdleTimeout = 2 * time.Minute
	maxConcurrent         = 32
)

var errUnsupportedProxyRequest = errors.New("only the WeChat HTTPS CONNECT target is allowed")

type proxy struct {
	dialer         net.Dialer
	sem            chan struct{}
	allowedClients []netip.Prefix
}

func newProxy() *proxy {
	return &proxy{
		dialer: net.Dialer{Timeout: connectTimeout, KeepAlive: 30 * time.Second},
		sem:    make(chan struct{}, maxConcurrent),
	}
}

func (p *proxy) serve(ctx context.Context, listener net.Listener) error {
	var wait sync.WaitGroup
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()

	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				wait.Wait()
				return nil
			}
			if errors.Is(err, net.ErrClosed) {
				wait.Wait()
				return nil
			}
			log.Printf("accept failed: %v", err)
			continue
		}
		if !p.allowsClient(conn.RemoteAddr()) {
			_ = conn.Close()
			continue
		}
		select {
		case p.sem <- struct{}{}:
		case <-ctx.Done():
			_ = conn.Close()
			continue
		default:
			writeError(conn, 503, "proxy is busy")
			_ = conn.Close()
			continue
		}
		wait.Add(1)
		go func() {
			defer wait.Done()
			defer func() { <-p.sem }()
			p.handle(conn)
		}()
	}
}

func parseAllowedClients(raw string) ([]netip.Prefix, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	var prefixes []netip.Prefix
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		prefix, err := netip.ParsePrefix(part)
		if err != nil || prefix.Masked().Addr().IsUnspecified() {
			return nil, fmt.Errorf("invalid WECHAT_PROXY_ALLOWED_CIDRS entry %q", part)
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes, nil
}

func (p *proxy) allowsClient(remote net.Addr) bool {
	if len(p.allowedClients) == 0 {
		return true
	}
	host, _, err := net.SplitHostPort(remote.String())
	if err != nil {
		return false
	}
	address, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	address = address.Unmap()
	for _, prefix := range p.allowedClients {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

func (p *proxy) handle(client net.Conn) {
	defer client.Close()
	_ = client.SetReadDeadline(time.Now().Add(connectTimeout))

	reader := bufio.NewReaderSize(client, maxConnectHeader)
	request, err := readConnectRequest(reader)
	if err != nil {
		writeError(client, 400, "invalid CONNECT request")
		return
	}
	if err := validateTarget(request.method, request.target); err != nil {
		writeError(client, 403, "target is not allowed")
		log.Printf("rejected CONNECT from %s: %v", remoteAddress(client), err)
		return
	}

	upstream, err := p.dialer.DialContext(context.Background(), "tcp4", allowedWechatTarget)
	if err != nil {
		writeError(client, 502, "unable to reach upstream")
		log.Printf("upstream dial failed for %s: %v", remoteAddress(client), err)
		return
	}
	defer upstream.Close()

	if _, err := io.WriteString(client, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		return
	}
	client = newIdleTimeoutConn(client, connectionIdleTimeout)
	upstream = newIdleTimeoutConn(upstream, connectionIdleTimeout)

	// CONNECT requests do not carry a body, so any buffered bytes are the
	// beginning of the tunneled TLS stream and must be forwarded upstream.
	if err := forwardBufferedTunnelData(upstream, reader); err != nil {
		return
	}
	finished := make(chan struct{}, 2)
	go proxyCopy(finished, upstream, client)
	go proxyCopy(finished, client, upstream)
	<-finished
}

type idleTimeoutConn struct {
	net.Conn
	timeout time.Duration
}

func newIdleTimeoutConn(conn net.Conn, timeout time.Duration) *idleTimeoutConn {
	wrapped := &idleTimeoutConn{Conn: conn, timeout: timeout}
	_ = conn.SetDeadline(time.Now().Add(timeout))
	return wrapped
}

func (conn *idleTimeoutConn) Read(data []byte) (int, error) {
	count, err := conn.Conn.Read(data)
	if count > 0 {
		_ = conn.Conn.SetDeadline(time.Now().Add(conn.timeout))
	}
	return count, err
}

func (conn *idleTimeoutConn) Write(data []byte) (int, error) {
	count, err := conn.Conn.Write(data)
	if count > 0 {
		_ = conn.Conn.SetDeadline(time.Now().Add(conn.timeout))
	}
	return count, err
}

func forwardBufferedTunnelData(destination io.Writer, reader *bufio.Reader) error {
	buffered := reader.Buffered()
	if buffered == 0 {
		return nil
	}
	_, err := io.CopyN(destination, reader, int64(buffered))
	return err
}

type connectRequest struct {
	method string
	target string
}

func readConnectRequest(reader *bufio.Reader) (connectRequest, error) {
	requestLine, err := readHeaderLine(reader)
	if err != nil || !strings.HasSuffix(requestLine, "\r\n") {
		return connectRequest{}, errors.New("invalid request line")
	}
	parts := strings.Fields(requestLine)
	if len(parts) != 3 {
		return connectRequest{}, errors.New("invalid request line")
	}
	if parts[2] != "HTTP/1.1" && parts[2] != "HTTP/1.0" {
		return connectRequest{}, errors.New("unsupported HTTP version")
	}
	headerBytes := len(requestLine)
	for {
		line, err := readHeaderLine(reader)
		if err != nil || len(line) > maxConnectHeader-headerBytes {
			return connectRequest{}, errors.New("invalid headers")
		}
		headerBytes += len(line)
		if line == "\r\n" {
			break
		}
	}
	return connectRequest{method: parts[0], target: parts[1]}, nil
}

func readHeaderLine(reader *bufio.Reader) (string, error) {
	line, err := reader.ReadSlice('\n')
	if err != nil {
		return "", err
	}
	if len(line) > maxConnectHeader {
		return "", errors.New("header line too long")
	}
	return string(line), nil
}

func validateTarget(method, target string) error {
	if method != "CONNECT" {
		return errUnsupportedProxyRequest
	}
	if !strings.EqualFold(target, allowedWechatTarget) {
		return errUnsupportedProxyRequest
	}
	return nil
}

func proxyCopy(done chan<- struct{}, destination io.Writer, source io.Reader) {
	_, _ = io.Copy(destination, source)
	done <- struct{}{}
}

func writeError(conn net.Conn, status int, message string) {
	_, _ = fmt.Fprintf(conn, "HTTP/1.1 %d %s\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", status, message)
}

func remoteAddress(conn net.Conn) string {
	if address := conn.RemoteAddr(); address != nil {
		return address.String()
	}
	return "unknown"
}

func newProxyListener(address, certPath, keyPath string, allowedClients []netip.Prefix) (net.Listener, error) {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return nil, fmt.Errorf("invalid WECHAT_PROXY_LISTEN: %w", err)
	}
	listenIP, err := netip.ParseAddr(host)
	if err != nil {
		return nil, fmt.Errorf("WECHAT_PROXY_LISTEN must use an IP address: %w", err)
	}
	if (certPath == "") != (keyPath == "") {
		return nil, errors.New("WECHAT_PROXY_TLS_CERT and WECHAT_PROXY_TLS_KEY must be configured together")
	}
	if !listenIP.IsPrivate() && !listenIP.IsLoopback() && (certPath == "" || len(allowedClients) == 0) {
		return nil, errors.New("public WeChat proxy listeners require TLS and WECHAT_PROXY_ALLOWED_CIDRS")
	}
	var listener net.Listener
	if certPath != "" {
		certificate, err := tls.LoadX509KeyPair(certPath, keyPath)
		if err != nil {
			return nil, fmt.Errorf("load WeChat proxy TLS certificate: %w", err)
		}
		listener, err = tls.Listen("tcp", address, &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{certificate}, NextProtos: []string{"http/1.1"}})
	} else {
		listener, err = net.Listen("tcp", address)
	}
	if err != nil {
		return nil, fmt.Errorf("listen on %s: %w", address, err)
	}
	return listener, nil
}

func run() error {
	address := strings.TrimSpace(os.Getenv("WECHAT_PROXY_LISTEN"))
	if address == "" {
		address = defaultListenAddress
	}
	allowedClients, err := parseAllowedClients(os.Getenv("WECHAT_PROXY_ALLOWED_CIDRS"))
	if err != nil {
		return err
	}
	certPath := strings.TrimSpace(os.Getenv("WECHAT_PROXY_TLS_CERT"))
	keyPath := strings.TrimSpace(os.Getenv("WECHAT_PROXY_TLS_KEY"))
	listener, err := newProxyListener(address, certPath, keyPath, allowedClients)
	if err != nil {
		return err
	}
	defer listener.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Printf("WeChat CONNECT proxy listening on %s tls=%t allowlist=%d", address, certPath != "", len(allowedClients))
	p := newProxy()
	p.allowedClients = allowedClients
	return p.serve(ctx, listener)
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
