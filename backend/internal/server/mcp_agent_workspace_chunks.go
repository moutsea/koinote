package server

import (
	"errors"
	"fmt"
)

// Keep both structuredContent and the SDK's text fallback below client output limits.
const mcpAgentWorkspaceReadChunkBytes = 8 << 10

var mcpAgentWorkspaceReadDescription = fmt.Sprintf("Read a byte range as base64 (default and maximum %d bytes). Start at offset 0; when hasMore is true, pass nextOffset and the returned sha256 as expectedSHA256. Decode each chunk separately, concatenate bytes, then verify the full sha256. Offsets count decoded bytes, not characters or base64 positions.", mcpAgentWorkspaceReadChunkBytes)

type mcpAgentWorkspaceReadRange struct {
	Offset         int64  `json:"offset,omitempty" jsonschema:"Decoded byte offset; defaults to zero."`
	Limit          int    `json:"limit,omitempty" jsonschema:"Maximum decoded bytes to return; omit for the server chunk limit."`
	ExpectedSHA256 string `json:"expectedSHA256,omitempty" jsonschema:"SHA256 from the first chunk. Required for nonzero offsets to prevent mixing file versions."`
}

func (r mcpAgentWorkspaceReadRange) validate() (int, error) {
	if r.Offset < 0 || r.Offset > agentWorkspaceMaxFileBytes || r.Limit < 0 || r.Limit > mcpAgentWorkspaceReadChunkBytes {
		return 0, fmt.Errorf("offset must be between 0 and %d; limit must be between 1 and %d (or omitted)", agentWorkspaceMaxFileBytes, mcpAgentWorkspaceReadChunkBytes)
	}
	if r.Offset > 0 && r.ExpectedSHA256 == "" {
		return 0, errors.New("expectedSHA256 is required when continuing a file read")
	}
	if r.Limit == 0 {
		return mcpAgentWorkspaceReadChunkBytes, nil
	}
	return r.Limit, nil
}

func (r mcpAgentWorkspaceReadRange) checkFile(size int64, sha256 string) error {
	if r.ExpectedSHA256 != "" && r.ExpectedSHA256 != sha256 {
		return errors.New("file content changed; refresh the manifest and restart from offset 0")
	}
	if r.Offset > size {
		return errAgentWorkspaceFileRange
	}
	return nil
}

type mcpAgentWorkspaceChunkRange struct {
	Offset     int64  `json:"offset"`
	NextOffset *int64 `json:"nextOffset"`
	HasMore    bool   `json:"hasMore"`
}

func newMCPAgentWorkspaceChunkRange(offset, length, size int64) mcpAgentWorkspaceChunkRange {
	r := mcpAgentWorkspaceChunkRange{Offset: offset, HasMore: offset+length < size}
	if r.HasMore {
		next := offset + length
		r.NextOffset = &next
	}
	return r
}

type mcpAgentWorkspaceFileChunk struct {
	agentWorkspaceFileContentView
	mcpAgentWorkspaceChunkRange
}

type mcpAgentWorkspaceCommitFileChunk struct {
	agentWorkspaceCommitFileContent
	mcpAgentWorkspaceChunkRange
}
