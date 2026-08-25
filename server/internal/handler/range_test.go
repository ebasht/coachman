package handler

import "testing"

func TestParseBytesRangeSafariSuffix(t *testing.T) {
	start, end, ok := parseBytesRange("bytes=-500")
	if !ok || start != -1 || end != 500 {
		t.Fatalf("suffix range = (%d, %d, %v), want (-1, 500, true)", start, end, ok)
	}
}

func TestParseBytesRangeRejectsEmptySuffix(t *testing.T) {
	if _, _, ok := parseBytesRange("bytes=-0"); ok {
		t.Fatal("bytes=-0 must be rejected")
	}
}

func TestCapStreamRangeBoundsAndroidOpenEndedRequest(t *testing.T) {
	start, end := capStreamRange(0, -1)
	if start != 0 || end != maxStreamRangeBytes-1 {
		t.Fatalf("capped range = %d-%d", start, end)
	}
}

func TestCapStreamRangePreservesSmallAndSuffixRequests(t *testing.T) {
	if start, end := capStreamRange(100, 999); start != 100 || end != 999 {
		t.Fatalf("small range changed to %d-%d", start, end)
	}
	if start, end := capStreamRange(-1, 500); start != -1 || end != 500 {
		t.Fatalf("suffix range changed to %d-%d", start, end)
	}
}
