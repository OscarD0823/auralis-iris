package main

import (
	"bytes"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os/exec"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed app
var assets embed.FS

const maxFile = 40 << 20

var transferID = regexp.MustCompile("^[a-f0-9]{32}$")

type parcel struct {
	id, name, kind string
	data           []byte
}

type pairing struct {
	keys   [2]string
	inbox  [2]*parcel
	busy   [2]bool
	joined bool
}

type relay struct {
	static http.Handler
	hosts  map[string]bool
	links  []string
	mu     sync.Mutex
	pair   *pairing
}

func token() string {
	key := make([]byte, 24)
	rand.Read(key)
	return hex.EncodeToString(key)
}

func localPeer(r *http.Request) bool {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	return err == nil && net.ParseIP(ip).IsLoopback()
}

func (s *relay) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	loopbackHost, allowed := s.hosts[r.Host]
	if !allowed {
		http.Error(w, "Usa la dirección que muestra Iris.", http.StatusForbidden)
		return
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Permissions-Policy", "microphone=(), geolocation=(), camera=(self)")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "Método no permitido.", http.StatusMethodNotAllowed)
			return
		}
		s.static.ServeHTTP(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet && r.Header.Get("Origin") != "http://"+r.Host {
		http.Error(w, "Origen no permitido.", http.StatusForbidden)
		return
	}
	local := loopbackHost && localPeer(r)
	switch {
	case r.URL.Path == "/api/info" && r.Method == http.MethodGet && local:
		writeJSON(w, map[string]string{"app": "auralis-iris"})
	case r.URL.Path == "/api/pair" && r.Method == http.MethodPost && local:
		s.startPair(w)
	default:
		s.exchange(w, r, local)
	}
}

func writeJSON(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(body)
}

func (s *relay) startPair(w http.ResponseWriter) {
	if len(s.links) == 0 {
		http.Error(w, "No se encontró una dirección IPv4 de la red local.", http.StatusServiceUnavailable)
		return
	}
	keys := [2]string{token(), token()}
	s.mu.Lock()
	s.pair = &pairing{keys: keys}
	s.mu.Unlock()
	time.AfterFunc(time.Hour, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.pair != nil && s.pair.keys[0] == keys[0] {
			s.pair = nil
		}
	})
	urls := make([]string, 0, len(s.links))
	for _, address := range s.links {
		urls = append(urls, "http://"+address+"/#lan="+keys[1])
	}
	writeJSON(w, struct {
		Key  string   `json:"key"`
		URLs []string `json:"urls"`
	}{keys[0], urls})
}

func (s *relay) exchange(w http.ResponseWriter, r *http.Request, local bool) {
	key := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	s.mu.Lock()
	pair := s.pair
	if pair == nil || key == "" || (key != pair.keys[1] && !(local && key == pair.keys[0])) {
		s.mu.Unlock()
		http.Error(w, "La vinculación ya no está disponible.", http.StatusGone)
		return
	}
	side := 1
	if key == pair.keys[0] {
		side = 0
	}
	switch {
	case r.URL.Path == "/api/pair" && r.Method == http.MethodDelete:
		s.pair = nil
	case r.URL.Path == "/api/join" && r.Method == http.MethodPost && side == 1 && !pair.joined:
		pair.joined = true
		guestKey := token()
		pair.keys[1] = guestKey
		s.mu.Unlock()
		writeJSON(w, map[string]string{"key": guestKey})
		return
	case r.URL.Path == "/api/outbox" && r.Method == http.MethodGet:
		if message := pair.inbox[1-side]; message != nil {
			w.Header().Set("X-Iris-Pending", message.id)
		}
	case r.URL.Path == "/api/inbox" && r.Method == http.MethodGet:
		message := pair.inbox[side]
		w.Header().Set("X-Iris-Online", strconv.FormatBool(pair.joined))
		s.mu.Unlock()
		if message == nil {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Header().Set("X-Iris-ID", message.id)
		w.Header().Set("X-Iris-Name", message.name)
		w.Header().Set("Content-Type", message.kind)
		w.Header().Set("Content-Length", strconv.Itoa(len(message.data)))
		w.Write(message.data)
		return
	case r.URL.Path == "/api/inbox" && r.Method == http.MethodDelete:
		if message := pair.inbox[side]; message != nil && message.id == r.Header.Get("X-Iris-ID") {
			pair.inbox[side] = nil
		}
	case r.URL.Path == "/api/inbox" && r.Method == http.MethodPost:
		recipient := 1 - side
		if !pair.joined || pair.inbox[recipient] != nil || pair.busy[recipient] {
			s.mu.Unlock()
			http.Error(w, "El otro dispositivo todavía no puede recibir archivos.", http.StatusConflict)
			return
		}
		pair.busy[recipient] = true
		s.mu.Unlock()
		s.acceptFile(w, r, pair, recipient)
		return
	default:
		s.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	s.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func (s *relay) acceptFile(w http.ResponseWriter, r *http.Request, pair *pairing, recipient int) {
	defer func() {
		s.mu.Lock()
		pair.busy[recipient] = false
		s.mu.Unlock()
	}()
	id, name, kind := r.Header.Get("X-Iris-ID"), r.Header.Get("X-Iris-Name"), r.Header.Get("Content-Type")
	if !transferID.MatchString(id) || len(name) > 1440 || (kind != "image/jpeg" && kind != "application/pdf") {
		http.Error(w, "Archivo no admitido.", http.StatusBadRequest)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxFile))
	if err != nil {
		http.Error(w, "El archivo debe pesar como máximo 40 MB.", http.StatusRequestEntityTooLarge)
		return
	}
	if (kind == "image/jpeg" && !bytes.HasPrefix(data, []byte{0xff, 0xd8, 0xff})) ||
		(kind == "application/pdf" && !bytes.HasPrefix(data, []byte("%PDF-"))) {
		http.Error(w, "Archivo no admitido.", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pair != pair {
		http.Error(w, "La vinculación terminó.", http.StatusGone)
		return
	}
	pair.inbox[recipient] = &parcel{id: id, name: name, kind: kind, data: data}
	w.WriteHeader(http.StatusAccepted)
}

func networkHosts(port string) (map[string]bool, []string) {
	hosts := map[string]bool{"127.0.0.1:" + port: true, "localhost:" + port: true}
	addresses, _ := net.InterfaceAddrs()
	var links []string
	for _, addr := range addresses {
		ip, _, err := net.ParseCIDR(addr.String())
		if err != nil || ip.To4() == nil || !ip.IsPrivate() {
			continue
		}
		host := net.JoinHostPort(ip.String(), port)
		if _, exists := hosts[host]; !exists {
			hosts[host] = false
			links = append(links, host)
		}
	}
	slices.SortFunc(links, func(a, b string) int {
		// Prioriza los rangos que suelen entregar los routers domésticos.
		rank := func(host string) int {
			if strings.HasPrefix(host, "192.168.") {
				return 0
			}
			if strings.HasPrefix(host, "10.") || strings.HasPrefix(host, "172.") {
				return 1
			}
			return 2
		}
		if diff := rank(a) - rank(b); diff != 0 {
			return diff
		}
		return strings.Compare(a, b)
	})
	return hosts, links
}

func main() {
	port := flag.Int("port", 53129, "puerto del escáner local")
	noBrowser := flag.Bool("no-browser", false, "servir el escáner sin abrir el navegador")
	flag.Parse()
	portText := strconv.Itoa(*port)
	if *port < 1024 || *port > 65535 {
		log.Fatal("Usa un puerto entre 1024 y 65535.")
	}
	localhost := "http://127.0.0.1:" + portText
	listener, err := net.Listen("tcp4", ":"+portText)
	if err != nil {
		client := http.Client{Timeout: time.Second}
		response, probe := client.Get(localhost + "/api/info")
		if probe == nil {
			defer response.Body.Close()
			body, _ := io.ReadAll(io.LimitReader(response.Body, 100))
			if response.StatusCode == http.StatusOK && bytes.Contains(body, []byte(`"auralis-iris"`)) {
				if !*noBrowser {
					openBrowser(localhost + "/")
				}
				return
			}
		}
		log.Fatalf("No se pudo abrir el puerto %s: %v", portText, err)
	}
	app, err := fs.Sub(assets, "app")
	if err != nil {
		log.Fatal(err)
	}
	hosts, links := networkHosts(portText)
	server := &http.Server{
		Handler:           &relay{static: http.FileServer(http.FS(app)), hosts: hosts, links: links},
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       40 * time.Second,
		WriteTimeout:      40 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    8192,
	}
	fmt.Printf("Auralis Iris BETA\n%s/\nDeja esta ventana abierta mientras uses el programa.\n", localhost)
	if !*noBrowser {
		openBrowser(localhost + "/")
	}
	if err := server.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func openBrowser(url string) {
	command := "xdg-open"
	args := []string{url}
	switch runtime.GOOS {
	case "windows":
		command = "rundll32.exe"
		args = []string{"url.dll,FileProtocolHandler", url}
	case "darwin":
		command = "open"
	}
	if err := exec.Command(command, args...).Start(); err != nil {
		log.Print("Abre la dirección anterior en el navegador.")
	}
}
