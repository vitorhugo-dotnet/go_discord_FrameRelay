package relaycontrol

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type CreateShareRequest struct {
	Provider          string `json:"provider"`
	GuildID           string `json:"guildId"`
	ChannelID         string `json:"channelId"`
	RequestedByUserID string `json:"requestedByUserId"`
	TTLSeconds        int    `json:"ttlSeconds"`
}

type ShareIntent struct {
	ID        string    `json:"id"`
	LaunchURL string    `json:"launchUrl"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type PendingIntent struct {
	ID                string    `json:"id"`
	GuildID           string    `json:"guildId"`
	ChannelID         string    `json:"channelId"`
	RequestedByUserID string    `json:"requestedByUserId"`
	Status            string    `json:"status"`
	ExpiresAt         time.Time `json:"expiresAt"`
}

type IntentStatus struct {
	ID             string    `json:"id"`
	Status         string    `json:"status"`
	SessionID      string    `json:"sessionId"`
	WatchLaunchURL string    `json:"watchLaunchUrl"`
	ExpiresAt      time.Time `json:"expiresAt"`
}

type WatchLaunch struct {
	LaunchURL string    `json:"launchUrl"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type publishedRequest struct {
	MessageID string `json:"messageId,omitempty"`
}

type CreateActivityRequest struct {
	Code              string `json:"code"`
	GuildID           string `json:"guildId"`
	ChannelID         string `json:"channelId"`
	RequestedByUserID string `json:"requestedByUserId"`
	TTLSeconds        int    `json:"ttlSeconds"`
}

type ActivityIntent struct {
	ID        string    `json:"id"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func (c *Client) CreateActivity(ctx context.Context, request CreateActivityRequest) (ActivityIntent, error) {
	request.Code = strings.ToUpper(strings.TrimSpace(request.Code))
	var response ActivityIntent
	err := c.doJSON(ctx, http.MethodPost, "/api/launch-intents/activity", request, &response)
	if err == nil && (response.ID == "" || !response.ExpiresAt.After(time.Now())) {
		err = fmt.Errorf("RelayControl returned an invalid Activity intent")
	}
	return response, err
}

type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

func NewClient(baseURL, token string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), token: token, http: httpClient}
}

func (c *Client) CreateShare(ctx context.Context, request CreateShareRequest) (ShareIntent, error) {
	var response ShareIntent
	err := c.doJSON(ctx, http.MethodPost, "/api/launch-intents/share", request, &response)
	return response, err
}

func (c *Client) ListPending(ctx context.Context) ([]PendingIntent, error) {
	var response []PendingIntent
	err := c.doJSON(ctx, http.MethodGet, "/api/launch-intents/pending", nil, &response)
	return response, err
}

func (c *Client) GetStatus(ctx context.Context, id string, watchTTLSeconds int) (IntentStatus, error) {
	var response IntentStatus
	err := c.doJSON(ctx, http.MethodGet,
		fmt.Sprintf("/api/launch-intents/%s?watchTtlSeconds=%d", id, watchTTLSeconds), nil, &response)
	return response, err
}

func (c *Client) MarkPublished(ctx context.Context, id, messageID string) error {
	return c.doJSON(ctx, http.MethodPost, "/api/launch-intents/"+id+"/published",
		publishedRequest{MessageID: messageID}, nil)
}

func (c *Client) CreateWatch(ctx context.Context, code string, ttlSeconds int) (WatchLaunch, error) {
	request := struct {
		Code       string `json:"code"`
		TTLSeconds int    `json:"ttlSeconds"`
	}{Code: strings.ToUpper(strings.TrimSpace(code)), TTLSeconds: ttlSeconds}
	var response WatchLaunch
	err := c.doJSON(ctx, http.MethodPost, "/api/launch-intents/watch", request, &response)
	return response, err
}

func (c *Client) doJSON(ctx context.Context, method, path string, input, output any) error {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return fmt.Errorf("encode RelayControl request: %w", err)
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return fmt.Errorf("create RelayControl request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("RelayControl request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var safe struct {
			Code string `json:"code"`
		}
		_ = json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&safe)
		return &RequestError{StatusCode: response.StatusCode, Code: safe.Code}
	}
	if output == nil || response.StatusCode == http.StatusNoContent {
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(output); err != nil {
		return fmt.Errorf("decode RelayControl response: %w", err)
	}
	return nil
}

type RequestError struct {
	StatusCode int
	Code       string
}

func (e *RequestError) Error() string {
	if e.Code == "" {
		return fmt.Sprintf("RelayControl returned HTTP %d", e.StatusCode)
	}
	return fmt.Sprintf("RelayControl returned HTTP %d (%s)", e.StatusCode, e.Code)
}
