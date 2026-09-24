package health

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthIsLiveAndReadinessTracksBothDependencies(t *testing.T) {
	readiness := &Readiness{}
	handler := Handler(readiness)

	live := httptest.NewRecorder()
	handler.ServeHTTP(live, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if live.Code != http.StatusOK {
		t.Fatalf("health status = %d", live.Code)
	}

	ready := httptest.NewRecorder()
	handler.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if ready.Code != http.StatusServiceUnavailable {
		t.Fatalf("readiness before dependencies = %d", ready.Code)
	}
	readiness.SetDiscord(true)
	readiness.SetRelayControl(true)
	ready = httptest.NewRecorder()
	handler.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if ready.Code != http.StatusOK {
		t.Fatalf("readiness after dependencies = %d", ready.Code)
	}
}
