package local_library

import (
	"net/http"
	"testing"
)

func TestCapOpenEndedMediaRange(t *testing.T) {
	const total = 100 << 20 // 100 MB
	cases := []struct {
		name  string
		input string
		want  string // "" = header unchanged
	}{
		{"open-ended from zero", "bytes=0-", "bytes=0-4194303"},
		{"open-ended mid-file", "bytes=1048576-", "bytes=1048576-5242879"},
		{"open-ended clamped to EOF", "bytes=104853760-", "bytes=104853760-104857599"},
		{"start beyond EOF left alone", "bytes=999999999-", ""},
		{"closed range untouched", "bytes=0-1023", ""},
		{"suffix range untouched", "bytes=-500", ""},
		{"multi range untouched", "bytes=0-99,200-299", ""},
		{"absent header untouched", "", ""},
		{"garbage untouched", "bytes=abc-", ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			request, err := http.NewRequest(http.MethodGet, "/", nil)
			if err != nil {
				t.Fatal(err)
			}
			if testCase.input != "" {
				request.Header.Set("Range", testCase.input)
			}
			capOpenEndedMediaRange(request, total)
			got := request.Header.Get("Range")
			want := testCase.want
			if want == "" {
				want = testCase.input
			}
			if got != want {
				t.Fatalf("Range = %q, want %q", got, want)
			}
		})
	}
}
