package server

import (
	"context"
	"log"
	"net/http"
	"sync"
	"time"
	_ "time/tzdata"

	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

const (
	adminTrendDays     = 30
	adminStatsCacheTTL = time.Minute
)

type adminOverview struct {
	Users           int64 `json:"users"`
	VerifiedUsers   int64 `json:"verifiedUsers"`
	Members         int64 `json:"members"`
	Documents       int64 `json:"documents"`
	Images          int64 `json:"images"`
	DocumentBytes   int64 `json:"documentBytes"`
	ImageBytes      int64 `json:"imageBytes"`
	Orders          int64 `json:"orders"`
	TodayNewUsers   int64 `json:"todayNewUsers"`
	TodayNewMembers int64 `json:"todayNewMembers"`
	TodayOrders     int64 `json:"todayOrders"`
}

type adminOverviewCache struct {
	mu            sync.Mutex
	todayStart    time.Time
	tomorrowStart time.Time
	cachedAt      time.Time
	value         adminOverview
}

func (c *adminOverviewCache) load(
	todayStart time.Time,
	tomorrowStart time.Time,
	loader func() (adminOverview, error),
) (adminOverview, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	if c.todayStart.Equal(todayStart) && c.tomorrowStart.Equal(tomorrowStart) &&
		!c.cachedAt.IsZero() && now.Sub(c.cachedAt) < adminStatsCacheTTL {
		return c.value, nil
	}
	value, err := loader()
	if err != nil {
		return adminOverview{}, err
	}
	c.todayStart = todayStart
	c.tomorrowStart = tomorrowStart
	c.cachedAt = now
	c.value = value
	return value, nil
}

type adminRevenue struct {
	Currency    string `json:"currency"`
	TotalAmount int64  `json:"totalAmount"`
	TotalOrders int64  `json:"totalOrders"`
	TodayAmount int64  `json:"todayAmount"`
	TodayOrders int64  `json:"todayOrders"`
}

type adminTrendPoint struct {
	Date       string `json:"date"`
	NewUsers   int64  `json:"newUsers"`
	NewMembers int64  `json:"newMembers"`
	Orders     int64  `json:"orders"`
}

type adminRecentUser struct {
	ID             int       `json:"id"`
	Name           string    `json:"name"`
	Email          string    `json:"email"`
	IsVerified     bool      `json:"isVerified"`
	MembershipTier string    `json:"membershipTier"`
	CreatedAt      time.Time `json:"createdAt"`
}

type adminRecentPayment struct {
	UserName  string    `json:"userName"`
	UserEmail string    `json:"userEmail"`
	Amount    int64     `json:"amount"`
	Currency  string    `json:"currency"`
	CreatedAt time.Time `json:"createdAt"`
}

type adminTraffic struct {
	Available      bool      `json:"available"`
	Reason         string    `json:"reason,omitempty"`
	PageViews      int64     `json:"pageViews"`
	UniqueVisitors int64     `json:"uniqueVisitors"`
	Requests       int64     `json:"requests"`
	Bytes          int64     `json:"bytes"`
	From           time.Time `json:"from"`
	To             time.Time `json:"to"`
}

type adminStatsResponse struct {
	GeneratedAt    time.Time            `json:"generatedAt"`
	TimeZone       string               `json:"timeZone"`
	Overview       adminOverview        `json:"overview"`
	Revenue        []adminRevenue       `json:"revenue"`
	Trend          []adminTrendPoint    `json:"trend"`
	RecentUsers    []adminRecentUser    `json:"recentUsers"`
	RecentPayments []adminRecentPayment `json:"recentPayments"`
	Traffic        adminTraffic         `json:"traffic"`
	Funnel         adminFunnel          `json:"funnel"`
	Retention      adminRetention       `json:"retention"`
}

type adminFunnel struct {
	Registered        int64 `json:"registered"`
	FirstDocument     int64 `json:"firstDocument"`
	FirstUpload       int64 `json:"firstUpload"`
	FirstExport       int64 `json:"firstExport"`
	MCPConnected      int64 `json:"mcpConnected"`
	CheckoutStarted   int64 `json:"checkoutStarted"`
	CheckoutCompleted int64 `json:"checkoutCompleted"`
}

type adminRetentionWindow struct {
	Eligible int64 `json:"eligible"`
	Returned int64 `json:"returned"`
}

type adminRetention struct {
	TrackingStartedAt time.Time            `json:"trackingStartedAt"`
	Day1              adminRetentionWindow `json:"day1"`
	Day7              adminRetentionWindow `json:"day7"`
	Day30             adminRetentionWindow `json:"day30"`
}

func (a *App) requireAdmin(w http.ResponseWriter, r *http.Request) (model.User, bool) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return model.User{}, false
	}
	if !user.IsAdmin {
		httpx.ErrorCode(w, http.StatusForbidden, "admin_required", "Administrator access required")
		return model.User{}, false
	}
	return user, true
}

func (a *App) adminStats(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}

	now := time.Now()
	location, err := time.LoadLocation(a.cfg.TimeZone)
	if err != nil {
		log.Printf("admin stats: invalid TZ %q, using UTC: %v", a.cfg.TimeZone, err)
		location = time.UTC
	}
	localNow := now.In(location)
	todayStartLocal := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, location)
	tomorrowStartLocal := todayStartLocal.AddDate(0, 0, 1)
	todayStart := todayStartLocal.UTC()
	tomorrowStart := tomorrowStartLocal.UTC()
	trendStartLocal := todayStartLocal.AddDate(0, 0, -(adminTrendDays - 1))

	overview, err := a.loadAdminOverview(r.Context(), todayStart, tomorrowStart)
	if err != nil {
		log.Printf("admin stats overview: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	revenue, err := a.loadAdminRevenue(r.Context(), todayStart, tomorrowStart)
	if err != nil {
		log.Printf("admin stats revenue: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	trend, err := a.loadAdminTrend(
		r.Context(),
		trendStartLocal,
		todayStartLocal,
		tomorrowStartLocal,
		location.String(),
	)
	if err != nil {
		log.Printf("admin stats trend: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	recentUsers, err := a.loadAdminRecentUsers(r.Context())
	if err != nil {
		log.Printf("admin stats recent users: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	recentPayments, err := a.loadAdminRecentPayments(r.Context())
	if err != nil {
		log.Printf("admin stats recent payments: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	funnel, err := a.loadAdminFunnel(r.Context())
	if err != nil {
		log.Printf("admin stats funnel: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	retention, err := a.loadAdminRetention(r.Context())
	if err != nil {
		log.Printf("admin stats retention: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	traffic := adminTraffic{From: todayStart, To: now.UTC()}
	if a.siteAnalytics == nil {
		traffic.Reason = "not_configured"
	} else if value, trafficErr := a.siteAnalytics.Traffic(r.Context(), todayStart, now.UTC()); trafficErr != nil {
		traffic.Reason = "upstream_error"
		log.Printf("admin stats Cloudflare analytics: %v", trafficErr)
	} else {
		traffic.Available = true
		traffic.PageViews = value.PageViews
		traffic.UniqueVisitors = value.UniqueVisitors
		traffic.Requests = value.Requests
		traffic.Bytes = value.Bytes
	}

	httpx.JSON(w, http.StatusOK, adminStatsResponse{
		GeneratedAt:    now.UTC(),
		TimeZone:       location.String(),
		Overview:       overview,
		Revenue:        revenue,
		Trend:          trend,
		RecentUsers:    recentUsers,
		RecentPayments: recentPayments,
		Traffic:        traffic,
		Funnel:         funnel,
		Retention:      retention,
	})
}

func (a *App) loadAdminFunnel(ctx context.Context) (adminFunnel, error) {
	rows, err := a.db.Query(ctx, `
		SELECT event_name, COUNT(*)
		FROM product_milestones
		GROUP BY event_name
	`)
	if err != nil {
		return adminFunnel{}, err
	}
	defer rows.Close()
	var funnel adminFunnel
	for rows.Next() {
		var event string
		var count int64
		if err := rows.Scan(&event, &count); err != nil {
			return adminFunnel{}, err
		}
		switch productMilestone(event) {
		case milestoneRegistered:
			funnel.Registered = count
		case milestoneFirstDocument:
			funnel.FirstDocument = count
		case milestoneFirstUpload:
			funnel.FirstUpload = count
		case milestoneFirstExport:
			funnel.FirstExport = count
		case milestoneMCPConnected:
			funnel.MCPConnected = count
		case milestoneCheckoutStarted:
			funnel.CheckoutStarted = count
		case milestoneCheckoutCompleted:
			funnel.CheckoutCompleted = count
		}
	}
	return funnel, rows.Err()
}

func (a *App) loadAdminRetention(ctx context.Context) (adminRetention, error) {
	var out adminRetention
	err := a.db.QueryRow(ctx, `
		WITH meta AS (
			SELECT tracking_started_at FROM product_analytics_meta WHERE singleton = true
		), eligible_users AS (
			SELECT
				u.id,
				(u.created_at AT TIME ZONE 'UTC')::date AS registered_on,
				(meta.tracking_started_at AT TIME ZONE 'UTC')::date AS tracking_on
			FROM users u CROSS JOIN meta
			WHERE u.created_at >= meta.tracking_started_at
		), today AS (
			SELECT (now() AT TIME ZONE 'UTC')::date AS day
		)
		SELECT
			(SELECT tracking_started_at FROM meta),
			COUNT(*) FILTER (WHERE registered_on <= today.day - 1),
			COUNT(*) FILTER (
				WHERE registered_on <= today.day - 1
				AND EXISTS (
					SELECT 1 FROM user_daily_activity a
					WHERE a.user_id = eligible_users.id
					  AND a.activity_date = eligible_users.registered_on + 1
				)
			),
			COUNT(*) FILTER (WHERE registered_on <= today.day - 7),
			COUNT(*) FILTER (
				WHERE registered_on <= today.day - 7
				AND EXISTS (
					SELECT 1 FROM user_daily_activity a
					WHERE a.user_id = eligible_users.id
					  AND a.activity_date = eligible_users.registered_on + 7
				)
			),
			COUNT(*) FILTER (WHERE registered_on <= today.day - 30),
			COUNT(*) FILTER (
				WHERE registered_on <= today.day - 30
				AND EXISTS (
					SELECT 1 FROM user_daily_activity a
					WHERE a.user_id = eligible_users.id
					  AND a.activity_date = eligible_users.registered_on + 30
				)
			)
		FROM eligible_users CROSS JOIN today
	`).Scan(
		&out.TrackingStartedAt,
		&out.Day1.Eligible,
		&out.Day1.Returned,
		&out.Day7.Eligible,
		&out.Day7.Returned,
		&out.Day30.Eligible,
		&out.Day30.Returned,
	)
	return out, err
}

func (a *App) loadAdminOverview(
	ctx context.Context,
	todayStart time.Time,
	tomorrowStart time.Time,
) (adminOverview, error) {
	return a.adminOverview.load(todayStart, tomorrowStart, func() (adminOverview, error) {
		return a.queryAdminOverview(ctx, todayStart, tomorrowStart)
	})
}

func (a *App) queryAdminOverview(
	ctx context.Context,
	todayStart time.Time,
	tomorrowStart time.Time,
) (adminOverview, error) {
	var out adminOverview
	err := a.db.QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM users),
			(SELECT COUNT(*) FROM users WHERE is_verified),
			(SELECT COUNT(*) FROM users WHERE membership_tier = 'lifetime'),
			(SELECT COUNT(*) FROM documents WHERE trashed_at IS NULL),
			(SELECT COUNT(*) FROM image_objects),
			COALESCE((SELECT SUM(octet_length(content) + octet_length(title)) FROM documents), 0)::bigint,
			COALESCE((SELECT SUM(bytes) FROM image_objects), 0)::bigint,
			(SELECT COUNT(*) FROM stripe_payments),
			(SELECT COUNT(*) FROM users WHERE created_at >= $1 AND created_at < $2),
			(SELECT COUNT(*) FROM users WHERE membership_granted_at >= $1 AND membership_granted_at < $2),
			(SELECT COUNT(*) FROM stripe_payments WHERE created_at >= $1 AND created_at < $2)
	`, todayStart, tomorrowStart).Scan(
		&out.Users,
		&out.VerifiedUsers,
		&out.Members,
		&out.Documents,
		&out.Images,
		&out.DocumentBytes,
		&out.ImageBytes,
		&out.Orders,
		&out.TodayNewUsers,
		&out.TodayNewMembers,
		&out.TodayOrders,
	)
	return out, err
}

func (a *App) loadAdminRevenue(
	ctx context.Context,
	todayStart time.Time,
	tomorrowStart time.Time,
) ([]adminRevenue, error) {
	rows, err := a.db.Query(ctx, `
		SELECT
			lower(currency),
			SUM(amount)::bigint,
			COUNT(*),
			COALESCE(SUM(amount) FILTER (WHERE created_at >= $1 AND created_at < $2), 0)::bigint,
			COUNT(*) FILTER (WHERE created_at >= $1 AND created_at < $2)
		FROM stripe_payments
		GROUP BY lower(currency)
		ORDER BY lower(currency)
	`, todayStart, tomorrowStart)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	revenue := make([]adminRevenue, 0)
	for rows.Next() {
		var item adminRevenue
		if err := rows.Scan(
			&item.Currency,
			&item.TotalAmount,
			&item.TotalOrders,
			&item.TodayAmount,
			&item.TodayOrders,
		); err != nil {
			return nil, err
		}
		revenue = append(revenue, item)
	}
	return revenue, rows.Err()
}

func (a *App) loadAdminTrend(
	ctx context.Context,
	firstDay time.Time,
	lastDay time.Time,
	end time.Time,
	timeZone string,
) ([]adminTrendPoint, error) {
	rows, err := a.db.Query(ctx, `
		WITH days AS (
			SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day
		), user_counts AS (
			SELECT (created_at AT TIME ZONE $3)::date AS day, COUNT(*) AS count
			FROM users
			WHERE created_at >= $4 AND created_at < $5
			GROUP BY 1
		), member_counts AS (
			SELECT (membership_granted_at AT TIME ZONE $3)::date AS day, COUNT(*) AS count
			FROM users
			WHERE membership_granted_at >= $4 AND membership_granted_at < $5
			GROUP BY 1
		), order_counts AS (
			SELECT (created_at AT TIME ZONE $3)::date AS day, COUNT(*) AS count
			FROM stripe_payments
			WHERE created_at >= $4 AND created_at < $5
			GROUP BY 1
		)
		SELECT
			to_char(days.day, 'YYYY-MM-DD'),
			COALESCE(user_counts.count, 0),
			COALESCE(member_counts.count, 0),
			COALESCE(order_counts.count, 0)
		FROM days
		LEFT JOIN user_counts USING (day)
		LEFT JOIN member_counts USING (day)
		LEFT JOIN order_counts USING (day)
		ORDER BY days.day
	`,
		firstDay.Format("2006-01-02"),
		lastDay.Format("2006-01-02"),
		timeZone,
		firstDay.UTC(),
		end.UTC(),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	trend := make([]adminTrendPoint, 0, adminTrendDays)
	for rows.Next() {
		var point adminTrendPoint
		if err := rows.Scan(&point.Date, &point.NewUsers, &point.NewMembers, &point.Orders); err != nil {
			return nil, err
		}
		trend = append(trend, point)
	}
	return trend, rows.Err()
}

func (a *App) loadAdminRecentUsers(ctx context.Context) ([]adminRecentUser, error) {
	rows, err := a.db.Query(ctx, `
		SELECT
			id,
			COALESCE(NULLIF(nickname, ''), NULLIF(username, ''), email),
			email,
			is_verified,
			membership_tier,
			created_at
		FROM users
		ORDER BY created_at DESC
		LIMIT 10
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	users := make([]adminRecentUser, 0, 10)
	for rows.Next() {
		var user adminRecentUser
		if err := rows.Scan(
			&user.ID,
			&user.Name,
			&user.Email,
			&user.IsVerified,
			&user.MembershipTier,
			&user.CreatedAt,
		); err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

func (a *App) loadAdminRecentPayments(ctx context.Context) ([]adminRecentPayment, error) {
	rows, err := a.db.Query(ctx, `
		SELECT
			COALESCE(NULLIF(users.nickname, ''), NULLIF(users.username, ''), users.email),
			users.email,
			stripe_payments.amount,
			lower(stripe_payments.currency),
			stripe_payments.created_at
		FROM stripe_payments
		JOIN users ON users.id = stripe_payments.user_id
		ORDER BY stripe_payments.created_at DESC
		LIMIT 10
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	payments := make([]adminRecentPayment, 0, 10)
	for rows.Next() {
		var payment adminRecentPayment
		if err := rows.Scan(
			&payment.UserName,
			&payment.UserEmail,
			&payment.Amount,
			&payment.Currency,
			&payment.CreatedAt,
		); err != nil {
			return nil, err
		}
		payments = append(payments, payment)
	}
	return payments, rows.Err()
}
