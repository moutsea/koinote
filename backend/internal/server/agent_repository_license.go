package server

import (
	"crypto/sha256"
	"fmt"
)

// Reviewed supplemental license text is pinned to its repository identity,
// exact path, root SPDX and content. Updates to that text require a new review;
// copying it to a different repository or path does not inherit approval.
func reviewedSystemRepositoryLicenseFile(file agentWorkspaceFile, repositoryID int64, license string) bool {
	// vinvcn/mattpocock-skills-zh-CN, bf98e53f92089fec9b4885f128a565d7eac0337f.
	// LICENSE.zh-CN.md is a non-binding Chinese translation that explicitly
	// defers to the root English LICENSE. Hash recorded in the curated catalog:
	// data/agent-repositories/catalog.json, request 560d5ba7-99ee-4162-80b0-6fcc9f98cfe2.
	if repositoryID != 1223387690 || file.Path != "LICENSE.zh-CN.md" || license != "MIT" {
		return false
	}
	// Hash the bytes being published, not the caller's cached SHA256 field.
	return fmt.Sprintf("%x", sha256.Sum256(file.Content)) == "091813fbbf1fbd0b507d3979479a05ffb5c608d7593453f461a9a18e2a577ae3"
}
