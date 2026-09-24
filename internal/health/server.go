package health

import (
	"encoding/json"
	"net/http"
	"sync/atomic"
)

type Readiness struct {
	discord      atomic.Bool
	relayControl atomic.Bool
}

func (r *Readiness) SetDiscord(ready bool)      { r.discord.Store(ready) }
func (r *Readiness) SetRelayControl(ready bool) { r.relayControl.Store(ready) }
func (r *Readiness) Ready() bool                { return r.discord.Load() && r.relayControl.Load() }

func Handler(readiness *Readiness) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if readiness == nil || !readiness.Ready() {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})
	return mux
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
