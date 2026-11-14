// Command security-go serves the Practacu Press security gRPC contract.
//
// It is the Go implementation of the service whose Rust predecessor lives in
// services/security. The Go API prefers it and falls back to the Rust service
// on a transport failure.
//
// The listen address is, in order of precedence:
//
//  1. the -addr flag,
//  2. the SECURITY_GO_GRPC_BIND environment variable,
//  3. 127.0.0.1:9002.
//
// SECURITY_ARGON2_CONCURRENCY and SECURITY_ARGON2_TIMEOUT_MS bound password
// hashing, exactly like the Rust service. They are logged at startup together
// with the address.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	"google.golang.org/grpc"

	securityv1 "github.com/practacu/practacu-press/packages/contracts/security/v1/gen"
	securitygo "github.com/practacu/practacu-press/services/security-go"
)

// DefaultAddr is the address used when neither the flag nor the environment
// supplies one. It is deliberately next to the Rust service's 127.0.0.1:9001.
const DefaultAddr = "127.0.0.1:9002"

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	addrFlag := flag.String("addr", "", "gRPC listen address (default $SECURITY_GO_GRPC_BIND or "+DefaultAddr+")")
	flag.Parse()

	addr := *addrFlag
	if addr == "" {
		addr = os.Getenv("SECURITY_GO_GRPC_BIND")
	}
	if addr == "" {
		addr = DefaultAddr
	}

	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", addr, err)
	}

	server := securitygo.NewServerFromEnv()
	limits := server.Limits()
	log.Printf("practacu-security-go argon2: concurrency=%d timeout=%s", limits.Concurrency, limits.Timeout)
	log.Printf("practacu-security-go listening on %s", listener.Addr())

	grpcServer := grpc.NewServer()
	securityv1.RegisterSecurityServiceServer(grpcServer, server)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- grpcServer.Serve(listener)
	}()

	select {
	case err := <-serveErr:
		if err != nil && !errors.Is(err, grpc.ErrServerStopped) {
			return fmt.Errorf("serve: %w", err)
		}
		return nil
	case <-ctx.Done():
		log.Printf("practacu-security-go shutting down")
		grpcServer.GracefulStop()
		return nil
	}
}
