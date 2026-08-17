package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/httpx"
)

const (
	announcementBodyMax         = 16 << 10
	announcementListLimit       = 50
	announcementUnreadLimit     = 10
	announcementPublishAttempts = 10
	announcementPublishWindow   = time.Hour
	maxBundledAnnouncementBytes = 256 << 10
)

var announcementLocales = []string{"en", "zh", "fr", "ja"}

type announcementTranslation struct {
	Title      string   `json:"title"`
	Summary    string   `json:"summary"`
	Highlights []string `json:"highlights"`
}

type announcementView struct {
	ID          int64                   `json:"id"`
	Kind        string                  `json:"kind"`
	Version     *string                 `json:"version"`
	PublishedAt time.Time               `json:"publishedAt"`
	Translation announcementTranslation `json:"translation"`
}

type adminAnnouncementView struct {
	ID           int64                              `json:"id"`
	Kind         string                             `json:"kind"`
	Version      *string                            `json:"version"`
	CreatedBy    *string                            `json:"createdBy"`
	CreatedAt    time.Time                          `json:"createdAt"`
	PublishedAt  time.Time                          `json:"publishedAt"`
	WithdrawnAt  *time.Time                         `json:"withdrawnAt"`
	Translations map[string]announcementTranslation `json:"translations"`
}

type bundledReleaseAnnouncement struct {
	Version      string                             `json:"version"`
	Translations map[string]announcementTranslation `json:"translations"`
}

func (a *App) announcementsUnread(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	locale := normalizeAnnouncementLocale(r.URL.Query().Get("locale"))
	rows, err := a.db.Query(r.Context(), `
		SELECT announcement.id, announcement.kind, announcement.version,
		       announcement.published_at, translation.title, translation.summary,
		       translation.highlights
		FROM announcements announcement
		JOIN announcement_translations translation
		  ON translation.announcement_id = announcement.id
		 AND translation.locale = $2
		WHERE announcement.published_at <= now()
		  AND announcement.withdrawn_at IS NULL
		  AND announcement.published_at >= (
		      SELECT created_at FROM users WHERE id = $1
		  )
		  AND NOT EXISTS (
		      SELECT 1 FROM announcement_reads reading
		      WHERE reading.user_id = $1
		        AND reading.announcement_id = announcement.id
		  )
		ORDER BY announcement.published_at, announcement.id
		LIMIT $3
	`, user.ID, locale, announcementUnreadLimit)
	if err != nil {
		log.Printf("announcement unread list: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer rows.Close()
	announcements := make([]announcementView, 0)
	for rows.Next() {
		var item announcementView
		if err := rows.Scan(
			&item.ID,
			&item.Kind,
			&item.Version,
			&item.PublishedAt,
			&item.Translation.Title,
			&item.Translation.Summary,
			&item.Translation.Highlights,
		); err != nil {
			log.Printf("announcement unread scan: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		announcements = append(announcements, item)
	}
	if err := rows.Err(); err != nil {
		log.Printf("announcement unread rows: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"announcements": announcements})
}

func (a *App) announcementMarkRead(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	announcementID, err := strconv.ParseInt(strings.TrimSpace(r.PathValue("announcementId")), 10, 64)
	if err != nil || announcementID <= 0 {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_announcement", "Invalid announcement")
		return
	}
	result, err := a.db.Exec(r.Context(), `
		INSERT INTO announcement_reads (user_id, announcement_id)
		SELECT $1, id FROM announcements
		WHERE id = $2
		  AND published_at <= now()
		  AND withdrawn_at IS NULL
		  AND published_at >= (
		      SELECT created_at FROM users WHERE id = $1
		  )
		ON CONFLICT (user_id, announcement_id) DO NOTHING
	`, user.ID, announcementID)
	if err != nil {
		log.Printf("announcement mark read: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if result.RowsAffected() == 0 {
		var exists bool
		if err := a.db.QueryRow(r.Context(), `
			SELECT EXISTS (
			    SELECT 1 FROM announcements
			    WHERE id = $2
			      AND published_at <= now()
			      AND withdrawn_at IS NULL
			      AND published_at >= (
			          SELECT created_at FROM users WHERE id = $1
			      )
			)
		`, user.ID, announcementID).Scan(&exists); err != nil {
			log.Printf("announcement mark read existence: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		if !exists {
			httpx.ErrorCode(w, http.StatusNotFound, "announcement_not_found", "Announcement not found")
			return
		}
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (a *App) adminAnnouncementsList(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT announcement.id, announcement.kind, announcement.version,
		       creator.email, announcement.created_at, announcement.published_at,
		       announcement.withdrawn_at,
		       translation.locale, translation.title, translation.summary,
		       translation.highlights
		FROM announcements announcement
		LEFT JOIN users creator ON creator.id = announcement.created_by
		JOIN announcement_translations translation
		  ON translation.announcement_id = announcement.id
		WHERE announcement.id IN (
		    SELECT id FROM announcements ORDER BY published_at DESC, id DESC LIMIT $1
		)
		ORDER BY announcement.published_at DESC, announcement.id DESC, translation.locale
	`, announcementListLimit)
	if err != nil {
		log.Printf("admin announcement list: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer rows.Close()
	items := make([]adminAnnouncementView, 0)
	indexByID := make(map[int64]int)
	for rows.Next() {
		var base adminAnnouncementView
		var locale string
		var translated announcementTranslation
		if err := rows.Scan(
			&base.ID,
			&base.Kind,
			&base.Version,
			&base.CreatedBy,
			&base.CreatedAt,
			&base.PublishedAt,
			&base.WithdrawnAt,
			&locale,
			&translated.Title,
			&translated.Summary,
			&translated.Highlights,
		); err != nil {
			log.Printf("admin announcement scan: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		idx, found := indexByID[base.ID]
		if !found {
			base.Translations = make(map[string]announcementTranslation)
			items = append(items, base)
			idx = len(items) - 1
			indexByID[base.ID] = idx
		}
		items[idx].Translations[locale] = translated
	}
	if err := rows.Err(); err != nil {
		log.Printf("admin announcement rows: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"announcements":      items,
		"translationEnabled": a.announcementTranslator != nil,
	})
}

func (a *App) adminAnnouncementWithdraw(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	announcementID, err := strconv.ParseInt(strings.TrimSpace(r.PathValue("announcementId")), 10, 64)
	if err != nil || announcementID <= 0 {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_announcement", "Invalid announcement")
		return
	}
	result, err := a.db.Exec(r.Context(), `
		UPDATE announcements
		SET withdrawn_at = COALESCE(withdrawn_at, now())
		WHERE id = $1
	`, announcementID)
	if err != nil {
		log.Printf("admin announcement withdraw: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if result.RowsAffected() == 0 {
		httpx.ErrorCode(w, http.StatusNotFound, "announcement_not_found", "Announcement not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (a *App) adminAnnouncementPublish(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	admin, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	if a.announcementTranslator == nil {
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "announcement_translation_not_configured", "Announcement translation is not configured")
		return
	}
	if !a.rateLimit().allow(fmt.Sprintf("announcement-publish:admin:%d", admin.ID), announcementPublishAttempts, announcementPublishWindow) {
		tooManyAttempts(w)
		return
	}
	var body struct {
		SourceLocale string                  `json:"sourceLocale"`
		Translation  announcementTranslation `json:"translation"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, announcementBodyMax)
	if err := decodeJSONBody(r, &body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}
	body.SourceLocale = normalizeAnnouncementLocaleStrict(body.SourceLocale)
	trimAnnouncementTranslation(&body.Translation)
	if body.SourceLocale == "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_locale", "Invalid announcement locale")
		return
	}
	if err := validateAnnouncementTranslation(body.Translation); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_announcement", err.Error())
		return
	}
	targets := make([]string, 0, len(announcementLocales)-1)
	for _, locale := range announcementLocales {
		if locale != body.SourceLocale {
			targets = append(targets, locale)
		}
	}
	translated, err := a.announcementTranslator.Translate(r.Context(), announcementTranslationInput{
		SourceLocale: body.SourceLocale,
		Targets:      targets,
		Source:       body.Translation,
	})
	if err != nil {
		log.Printf("admin announcement translation: %v", err)
		httpx.ErrorCode(w, http.StatusBadGateway, "announcement_translation_failed", "Announcement translation failed")
		return
	}
	translations := make(map[string]announcementTranslation, len(announcementLocales))
	translations[body.SourceLocale] = body.Translation
	for _, locale := range targets {
		translation := translated[locale]
		trimAnnouncementTranslation(&translation)
		if err := validateAnnouncementTranslation(translation); err != nil || len(translation.Highlights) != len(body.Translation.Highlights) {
			log.Printf("admin announcement translation validation for %s: %v", locale, err)
			httpx.ErrorCode(w, http.StatusBadGateway, "announcement_translation_failed", "Announcement translation failed")
			return
		}
		translations[locale] = translation
	}

	created, err := a.insertAnnouncement(r.Context(), "manual", nil, &admin.ID, time.Now().UTC(), translations)
	if err != nil {
		log.Printf("admin announcement publish: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	created.CreatedBy = &admin.Email
	httpx.JSON(w, http.StatusCreated, map[string]any{"announcement": created})
}

func (a *App) insertAnnouncement(
	ctx context.Context,
	kind string,
	version *string,
	createdBy *int,
	publishedAt time.Time,
	translations map[string]announcementTranslation,
) (adminAnnouncementView, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return adminAnnouncementView{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var item adminAnnouncementView
	err = tx.QueryRow(ctx, `
		INSERT INTO announcements (kind, version, created_by, published_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (version) DO NOTHING
		RETURNING id, kind, version, created_at, published_at
	`, kind, version, createdBy, publishedAt).Scan(&item.ID, &item.Kind, &item.Version, &item.CreatedAt, &item.PublishedAt)
	if err != nil {
		return adminAnnouncementView{}, err
	}
	item.Translations = translations
	for _, locale := range announcementLocales {
		translation, ok := translations[locale]
		if !ok {
			return adminAnnouncementView{}, fmt.Errorf("missing announcement locale %s", locale)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO announcement_translations
			    (announcement_id, locale, title, summary, highlights)
			VALUES ($1, $2, $3, $4, $5)
		`, item.ID, locale, translation.Title, translation.Summary, translation.Highlights); err != nil {
			return adminAnnouncementView{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return adminAnnouncementView{}, err
	}
	return item, nil
}

func (a *App) SyncBundledReleaseAnnouncement(ctx context.Context) error {
	path := strings.TrimSpace(a.cfg.ReleaseAnnouncementPath)
	if path == "" {
		return nil
	}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("open release announcement: %w", err)
	}
	defer file.Close()
	var bundled bundledReleaseAnnouncement
	decoder := json.NewDecoder(io.LimitReader(file, maxBundledAnnouncementBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&bundled); err != nil {
		return fmt.Errorf("decode release announcement: %w", err)
	}
	bundled.Version = strings.TrimSpace(bundled.Version)
	if bundled.Version == "" {
		return errors.New("release announcement version is required")
	}
	for _, locale := range announcementLocales {
		translation, ok := bundled.Translations[locale]
		if !ok {
			return fmt.Errorf("release announcement missing locale %s", locale)
		}
		trimAnnouncementTranslation(&translation)
		if err := validateAnnouncementTranslation(translation); err != nil {
			return fmt.Errorf("release announcement locale %s: %w", locale, err)
		}
		bundled.Translations[locale] = translation
	}

	version := bundled.Version
	if _, err := a.insertAnnouncement(ctx, "release", &version, nil, time.Now().UTC(), bundled.Translations); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return fmt.Errorf("insert release announcement: %w", err)
	}
	log.Printf("已导入 Koinote %s 版本提醒", bundled.Version)
	return nil
}

func normalizeAnnouncementLocale(value string) string {
	if locale := normalizeAnnouncementLocaleStrict(value); locale != "" {
		return locale
	}
	return "en"
}

func normalizeAnnouncementLocaleStrict(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	for _, locale := range announcementLocales {
		if value == locale {
			return locale
		}
	}
	return ""
}

func trimAnnouncementTranslation(translation *announcementTranslation) {
	translation.Title = strings.TrimSpace(translation.Title)
	translation.Summary = strings.TrimSpace(translation.Summary)
	for idx := range translation.Highlights {
		translation.Highlights[idx] = strings.TrimSpace(translation.Highlights[idx])
	}
}

func validateAnnouncementTranslation(translation announcementTranslation) error {
	if count := utf8.RuneCountInString(strings.TrimSpace(translation.Title)); count < 1 || count > 160 {
		return errors.New("announcement title must contain 1 to 160 characters")
	}
	if count := utf8.RuneCountInString(strings.TrimSpace(translation.Summary)); count < 1 || count > 600 {
		return errors.New("announcement summary must contain 1 to 600 characters")
	}
	if len(translation.Highlights) < 1 || len(translation.Highlights) > 8 {
		return errors.New("announcement must contain 1 to 8 highlights")
	}
	for _, highlight := range translation.Highlights {
		if count := utf8.RuneCountInString(strings.TrimSpace(highlight)); count < 1 || count > 500 {
			return errors.New("each announcement highlight must contain 1 to 500 characters")
		}
	}
	return nil
}
