package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"koinote/backend/internal/config"
)

const cloudflareGraphQLEndpoint = "https://api.cloudflare.com/client/v4/graphql"

type siteTraffic struct {
	PageViews      int64
	UniqueVisitors int64
	Requests       int64
	Bytes          int64
}

type siteAnalyticsClient interface {
	Traffic(context.Context, time.Time, time.Time) (siteTraffic, error)
}

type httpDoer interface {
	Do(*http.Request) (*http.Response, error)
}

type trafficCache struct {
	dayStart time.Time
	cachedAt time.Time
	traffic  siteTraffic
}

type trafficFlight struct {
	done    chan struct{}
	traffic siteTraffic
	err     error
}

type cloudflareAnalyticsClient struct {
	zoneID   string
	token    string
	hostname string
	endpoint string
	http     httpDoer
	cacheMu  sync.Mutex
	cache    trafficCache
	inflight map[string]*trafficFlight
}

func newCloudflareAnalyticsClient(cfg config.Config) siteAnalyticsClient {
	if cfg.CloudflareZoneID == "" || cfg.CloudflareAnalyticsToken == "" || cfg.CloudflareAnalyticsHost == "" {
		return nil
	}
	return &cloudflareAnalyticsClient{
		zoneID:   cfg.CloudflareZoneID,
		token:    cfg.CloudflareAnalyticsToken,
		hostname: cfg.CloudflareAnalyticsHost,
		endpoint: cloudflareGraphQLEndpoint,
		http:     &http.Client{Timeout: 5 * time.Second},
	}
}

func (c *cloudflareAnalyticsClient) Traffic(
	ctx context.Context,
	start time.Time,
	end time.Time,
) (siteTraffic, error) {
	cacheKey := start.UTC().Format(time.RFC3339Nano)
	c.cacheMu.Lock()
	if c.cache.dayStart.Equal(start) && time.Since(c.cache.cachedAt) < time.Minute {
		cached := c.cache.traffic
		c.cacheMu.Unlock()
		return cached, nil
	}
	if flight := c.inflight[cacheKey]; flight != nil {
		c.cacheMu.Unlock()
		select {
		case <-flight.done:
			return flight.traffic, flight.err
		case <-ctx.Done():
			return siteTraffic{}, ctx.Err()
		}
	}
	if c.inflight == nil {
		c.inflight = make(map[string]*trafficFlight)
	}
	flight := &trafficFlight{done: make(chan struct{})}
	c.inflight[cacheKey] = flight
	c.cacheMu.Unlock()

	traffic, err := c.query(ctx, start, end)

	c.cacheMu.Lock()
	if err == nil {
		c.cache = trafficCache{dayStart: start, cachedAt: time.Now(), traffic: traffic}
	}
	flight.traffic = traffic
	flight.err = err
	delete(c.inflight, cacheKey)
	close(flight.done)
	c.cacheMu.Unlock()
	return traffic, err
}

func (c *cloudflareAnalyticsClient) query(
	ctx context.Context,
	start time.Time,
	end time.Time,
) (siteTraffic, error) {
	const query = `
		query KoinoteAdminTraffic(
			$zoneTag: string!
			$start: Time!
			$end: Time!
			$hostname: string!
		) {
			viewer {
				zones(filter: { zoneTag: $zoneTag }) {
					httpRequests1mGroups(
						limit: 1
						filter: {
							datetime_geq: $start
							datetime_lt: $end
							clientRequestHTTPHost: $hostname
						}
					) {
						sum { pageViews requests bytes }
						uniq { uniques }
					}
				}
			}
		}`

	payload, err := json.Marshal(map[string]any{
		"query": query,
		"variables": map[string]string{
			"zoneTag":  c.zoneID,
			"start":    start.UTC().Format(time.RFC3339),
			"end":      end.UTC().Format(time.RFC3339),
			"hostname": c.hostname,
		},
	})
	if err != nil {
		return siteTraffic{}, fmt.Errorf("encode Cloudflare analytics query: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(payload))
	if err != nil {
		return siteTraffic{}, fmt.Errorf("create Cloudflare analytics request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")

	response, err := c.http.Do(req)
	if err != nil {
		return siteTraffic{}, fmt.Errorf("request Cloudflare analytics: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return siteTraffic{}, fmt.Errorf("Cloudflare analytics returned HTTP %d", response.StatusCode)
	}

	var result struct {
		Data struct {
			Viewer struct {
				Zones []struct {
					Groups []struct {
						Sum struct {
							PageViews int64 `json:"pageViews"`
							Requests  int64 `json:"requests"`
							Bytes     int64 `json:"bytes"`
						} `json:"sum"`
						Uniq struct {
							Uniques int64 `json:"uniques"`
						} `json:"uniq"`
					} `json:"httpRequests1mGroups"`
				} `json:"zones"`
			} `json:"viewer"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1<<20))
	if err := decoder.Decode(&result); err != nil {
		return siteTraffic{}, fmt.Errorf("decode Cloudflare analytics response: %w", err)
	}
	if len(result.Errors) > 0 {
		return siteTraffic{}, fmt.Errorf("Cloudflare analytics GraphQL error: %s", result.Errors[0].Message)
	}
	if len(result.Data.Viewer.Zones) == 0 {
		return siteTraffic{}, errors.New("Cloudflare analytics returned no zone")
	}
	groups := result.Data.Viewer.Zones[0].Groups
	if len(groups) == 0 {
		return siteTraffic{}, nil
	}
	return siteTraffic{
		PageViews:      groups[0].Sum.PageViews,
		UniqueVisitors: groups[0].Uniq.Uniques,
		Requests:       groups[0].Sum.Requests,
		Bytes:          groups[0].Sum.Bytes,
	}, nil
}
