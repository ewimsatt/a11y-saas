package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	listenAddress    = "0.0.0.0:4750"
	smokescreenAddr  = "127.0.0.1:4751"
	smokescreenProxy = "http://127.0.0.1:4751"
)

var transport = &http.Transport{
	Proxy:                 http.ProxyURL(mustURL(smokescreenProxy)),
	DialContext:           (&net.Dialer{Timeout: 10 * time.Second}).DialContext,
	ForceAttemptHTTP2:     false,
	MaxIdleConns:          64,
	IdleConnTimeout:       60 * time.Second,
	ResponseHeaderTimeout: 30 * time.Second,
}

func mustURL(raw string) *url.URL {
	u, err := url.Parse(raw)
	if err != nil {
		panic(err)
	}
	return u
}

func destination(req *http.Request) (string, int, error) {
	authority := req.URL.Host
	if req.Method == http.MethodConnect || authority == "" {
		authority = req.Host
	}
	if authority == "" {
		return "", 0, errors.New("missing destination authority")
	}

	host := authority
	port := ""
	if splitHost, splitPort, err := net.SplitHostPort(authority); err == nil {
		host, port = splitHost, splitPort
	} else if strings.Contains(authority, ":") && !strings.HasPrefix(authority, "[") {
		return "", 0, errors.New("malformed destination authority")
	}
	if port == "" {
		switch strings.ToLower(req.URL.Scheme) {
		case "http":
			port = "80"
		case "https":
			port = "443"
		default:
			return "", 0, errors.New("destination port required")
		}
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return "", 0, errors.New("invalid destination port")
	}
	return host, portNumber, nil
}

func allowedPort(port int) bool { return port == 80 || port == 443 }

func copyHeaders(dst, src http.Header) {
	for key, values := range src {
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}

func deny(w http.ResponseWriter, host string, port int, reason string) {
	log.Printf("destination_decision allow=false host=%q port=%d reason=%q", host, port, reason)
	w.Header().Set("X-Scanner-Egress-Error", "destination denied")
	http.Error(w, "scanner egress policy denied destination", http.StatusForbidden)
}

func proxyHTTP(w http.ResponseWriter, req *http.Request) {
	out := req.Clone(req.Context())
	out.RequestURI = ""
	out.Header = req.Header.Clone()
	out.Header.Del("Proxy-Authorization")
	resp, err := transport.RoundTrip(out)
	if err != nil {
		http.Error(w, "scanner egress proxy unavailable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	copyHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func proxyConnect(w http.ResponseWriter, req *http.Request) {
	upstream, err := net.DialTimeout("tcp", smokescreenAddr, 10*time.Second)
	if err != nil {
		http.Error(w, "scanner egress proxy unavailable", http.StatusBadGateway)
		return
	}
	defer upstream.Close()

	if _, err := fmt.Fprintf(upstream, "CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n", req.Host, req.Host); err != nil {
		http.Error(w, "scanner egress proxy unavailable", http.StatusBadGateway)
		return
	}
	reader := bufio.NewReader(upstream)
	resp, err := http.ReadResponse(reader, req)
	if err != nil {
		http.Error(w, "scanner egress proxy unavailable", http.StatusBadGateway)
		return
	}
	if resp.StatusCode != http.StatusOK {
		copyHeaders(w.Header(), resp.Header)
		w.WriteHeader(resp.StatusCode)
		if resp.Body != nil {
			defer resp.Body.Close()
			_, _ = io.Copy(w, resp.Body)
		}
		return
	}

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "connection tunneling unavailable", http.StatusInternalServerError)
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer client.Close()
	_, _ = buffered.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
	_ = buffered.Flush()

	clientReader := io.Reader(client)
	if buffered.Reader.Buffered() > 0 {
		clientReader = buffered
	}
	upstreamReader := io.Reader(upstream)
	if reader.Buffered() > 0 {
		upstreamReader = reader
	}
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(upstream, clientReader); done <- struct{}{} }()
	go func() { _, _ = io.Copy(client, upstreamReader); done <- struct{}{} }()
	<-done
}

func handler(w http.ResponseWriter, req *http.Request) {
	host, port, err := destination(req)
	if err != nil {
		deny(w, "", 0, err.Error())
		return
	}
	if !allowedPort(port) {
		deny(w, host, port, "only destination ports 80 and 443 are permitted")
		return
	}
	log.Printf("destination_decision allow=true host=%q port=%d", host, port)
	if req.Method == http.MethodConnect {
		proxyConnect(w, req)
		return
	}
	proxyHTTP(w, req)
}

func waitForSmokescreen(child *exec.Cmd) error {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", smokescreenAddr, 100*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return nil
		}
		if child.ProcessState != nil && child.ProcessState.Exited() {
			return errors.New("Smokescreen exited before becoming ready")
		}
		time.Sleep(50 * time.Millisecond)
	}
	return errors.New("Smokescreen did not become ready")
}

func main() {
	args := []string{"--config-file", "/etc/smokescreen/smokescreen.yaml", "--listen-port", "4751"}
	args = append(args, os.Args[1:]...)
	child := exec.Command("/usr/local/bin/smokescreen", args...)
	child.Stdout, child.Stderr = os.Stdout, os.Stderr
	if err := child.Start(); err != nil {
		log.Fatal(err)
	}
	childDone := make(chan error, 1)
	go func() { childDone <- child.Wait() }()
	if err := waitForSmokescreen(child); err != nil {
		_ = child.Process.Kill()
		log.Fatal(err)
	}

	server := &http.Server{
		Addr:              listenAddress,
		Handler:           http.HandlerFunc(handler),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	serverDone := make(chan error, 1)
	go func() { serverDone <- server.ListenAndServe() }()
	log.Printf("scanner egress port guard listening on %s; upstream Smokescreen=%s", listenAddress, smokescreenAddr)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	select {
	case sig := <-signals:
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = server.Shutdown(ctx)
		cancel()
		_ = child.Process.Signal(sig)
		<-childDone
	case err := <-childDone:
		_ = server.Close()
		if err != nil {
			log.Fatalf("Smokescreen exited: %v", err)
		}
	case err := <-serverDone:
		_ = child.Process.Signal(syscall.SIGTERM)
		<-childDone
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("port guard exited: %v", err)
		}
	}
}
