package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultListenAddress = "10.77.0.1:18080"
	allowedWechatHost    = "api.weixin.qq.com"
	allowedWechatTarget  = allowedWechatHost + ":443"
	maxConnectHeader     = 8 << 10
	connectTimeout       = 15 * time.Second
	connectionLifetime   = 2 * time.Minute
	maxConcurrent        = 32
)

var errUnsupportedProxyRequest = errors.New("only the WeChat HTTPS CONNECT target is allowed")

type proxy struct {
	dialer net.Dialer
	sem    chan struct{}
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
	_ = client.SetDeadline(time.Now().Add(connectionLifetime))
	_ = upstream.SetDeadline(time.Now().Add(connectionLifetime))

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

func run() error {
	address := strings.TrimSpace(os.Getenv("WECHAT_PROXY_LISTEN"))
	if address == "" {
		address = defaultListenAddress
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", address, err)
	}
	defer listener.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Printf("WeChat CONNECT proxy listening on %s", address)
	return newProxy().serve(ctx, listener)
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
