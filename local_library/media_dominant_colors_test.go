package local_library

import (
	"image"
	"image/color"
	"math"
	"math/rand"
	"testing"
)

// The scenes below rebuild the four cases used to diagnose the old algorithm.
// Every one of them is a small subject over a large dark background, and the
// background carries a gradient plus sensor noise — flat synthetic colours hide
// the defect, because a single-colour background lands in one bucket instead of
// shattering across dozens of neighbouring ones.

type rgbTriplet = [3]float64

func noisyGradientScene(size int, top, bottom rgbTriplet, noise int, seed int64) *image.RGBA {
	rng := rand.New(rand.NewSource(seed))
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	for y := 0; y < size; y++ {
		t := float64(y) / float64(size-1)
		for x := 0; x < size; x++ {
			n := float64(rng.Intn(2*noise+1) - noise)
			img.SetRGBA(x, y, color.RGBA{
				R: roundToByte(top[0] + (bottom[0]-top[0])*t + n),
				G: roundToByte(top[1] + (bottom[1]-top[1])*t + n),
				B: roundToByte(top[2] + (bottom[2]-top[2])*t + n),
				A: 255,
			})
		}
	}
	return img
}

func fillRect(img *image.RGBA, x0, y0, x1, y1 int, c rgbTriplet) {
	for y := y0; y <= y1; y++ {
		for x := x0; x <= x1; x++ {
			if p := image.Pt(x, y); p.In(img.Bounds()) {
				img.SetRGBA(x, y, color.RGBA{R: byte(c[0]), G: byte(c[1]), B: byte(c[2]), A: 255})
			}
		}
	}
}

func fillEllipse(img *image.RGBA, cx, cy, rx, ry int, c rgbTriplet) {
	for y := cy - ry; y <= cy+ry; y++ {
		for x := cx - rx; x <= cx+rx; x++ {
			dx := float64(x-cx) / float64(rx)
			dy := float64(y-cy) / float64(ry)
			if dx*dx+dy*dy > 1 {
				continue
			}
			if p := image.Pt(x, y); p.In(img.Bounds()) {
				img.SetRGBA(x, y, color.RGBA{R: byte(c[0]), G: byte(c[1]), B: byte(c[2]), A: 255})
			}
		}
	}
}

func speckle(img *image.RGBA, count int, palette []rgbTriplet, minR, maxR int, seed int64) {
	rng := rand.New(rand.NewSource(seed))
	bounds := img.Bounds()
	for i := 0; i < count; i++ {
		c := palette[rng.Intn(len(palette))]
		r := minR + rng.Intn(maxR-minR+1)
		cx := bounds.Min.X + rng.Intn(bounds.Dx())
		cy := bounds.Min.Y + rng.Intn(bounds.Dy())
		fillEllipse(img, cx, cy, r, r, c)
	}
}

type colorScene struct {
	name    string
	build   func() *image.RGBA
	targets []rgbTriplet
}

func dominantColorScenes() []colorScene {
	return []colorScene{
		{
			name: "night-city",
			build: func() *image.RGBA {
				img := noisyGradientScene(200, rgbTriplet{4, 7, 14}, rgbTriplet{24, 36, 61}, 9, 3)
				windows := rgbTriplet{247, 202, 74}
				for bx := 20; bx < 180; bx += 26 {
					for by := 120; by < 190; by += 22 {
						if (bx+by)%3 != 0 {
							fillRect(img, bx, by, bx+12, by+9, windows)
						}
					}
				}
				fillRect(img, 60, 30, 140, 46, rgbTriplet{232, 129, 58})
				speckle(img, 40, []rgbTriplet{windows, {232, 129, 58}}, 1, 3, 5)
				return img
			},
			targets: []rgbTriplet{{247, 202, 74}, {232, 129, 58}},
		},
		{
			name: "low-key-portrait",
			build: func() *image.RGBA {
				img := noisyGradientScene(200, rgbTriplet{22, 18, 16}, rgbTriplet{58, 48, 42}, 11, 13)
				skin := rgbTriplet{214, 158, 128}
				fillEllipse(img, 100, 75, 36, 37, skin)
				speckle(img, 300, []rgbTriplet{skin, {198, 142, 114}}, 1, 2, 17)
				fillRect(img, 70, 138, 130, 199, rgbTriplet{176, 55, 55})
				speckle(img, 120, []rgbTriplet{{176, 55, 55}, {158, 46, 46}}, 1, 2, 19)
				return img
			},
			targets: []rgbTriplet{{214, 158, 128}, {176, 55, 55}},
		},
		{
			name: "red-flower-dark-leaves",
			build: func() *image.RGBA {
				img := noisyGradientScene(200, rgbTriplet{12, 30, 20}, rgbTriplet{34, 66, 46}, 13, 23)
				speckle(img, 900, []rgbTriplet{{20, 45, 30}, {28, 58, 38}, {16, 38, 26}}, 2, 6, 29)
				red := rgbTriplet{196, 38, 44}
				for _, c := range [][2]int{{62, 66}, {132, 78}, {98, 136}} {
					fillEllipse(img, c[0], c[1], 30, 28, red)
				}
				speckle(img, 400, []rgbTriplet{red, {178, 32, 38}}, 1, 3, 31)
				fillEllipse(img, 101, 103, 9, 9, rgbTriplet{244, 196, 80})
				return img
			},
			targets: []rgbTriplet{{196, 38, 44}, {244, 196, 80}},
		},
		{
			name: "off-centre-subject",
			build: func() *image.RGBA {
				img := noisyGradientScene(200, rgbTriplet{10, 12, 16}, rgbTriplet{30, 34, 44}, 10, 37)
				cyan := rgbTriplet{64, 196, 208}
				fillEllipse(img, 49, 160, 35, 32, cyan)
				speckle(img, 260, []rgbTriplet{cyan, {52, 178, 190}}, 1, 3, 41)
				fillRect(img, 150, 20, 190, 40, rgbTriplet{232, 96, 72})
				return img
			},
			targets: []rgbTriplet{{64, 196, 208}, {232, 96, 72}},
		},
	}
}

func hexToLabTriplet(c rgbTriplet) labColor {
	return srgbToLab(byte(c[0]), byte(c[1]), byte(c[2]))
}

func parseHexColor(value string) labColor {
	var r, g, b uint8
	if len(value) == 7 && value[0] == '#' {
		r = uint8(hexDigit(value[1])<<4 | hexDigit(value[2]))
		g = uint8(hexDigit(value[3])<<4 | hexDigit(value[4]))
		b = uint8(hexDigit(value[5])<<4 | hexDigit(value[6]))
	}
	return srgbToLab(r, g, b)
}

func hexDigit(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10
	}
	return 0
}

// TestExtractDominantColorsPrefersSubjectOverBackground is the regression guard
// for the complaint that a palette showed the darkness of a photo instead of its
// subject. It asserts three things per scene: the subject colours are present,
// no near-black or grey placeholder survives, and no two swatches are the same
// colour wearing a slightly different hex code.
func TestExtractDominantColorsPrefersSubjectOverBackground(t *testing.T) {
	totalTargets := 0
	hits := 0
	placeholders := 0
	duplicates := 0
	for _, scene := range dominantColorScenes() {
		got := extractDominantColors(scene.build(), 5)
		if len(got) == 0 {
			t.Fatalf("%s: palette is empty", scene.name)
		}
		labs := make([]labColor, 0, len(got))
		for _, value := range got {
			lab := parseHexColor(value)
			if lab.l < 25 || lab.chroma() < 12 {
				placeholders++
				t.Errorf("%s: placeholder swatch %s (L*=%.1f chroma=%.1f)", scene.name, value, lab.l, lab.chroma())
			}
			labs = append(labs, lab)
		}
		for i := 0; i < len(labs); i++ {
			for j := i + 1; j < len(labs); j++ {
				if labs[i].deltaE76(labs[j]) < dominantColorMinDeltaE {
					duplicates++
					t.Errorf("%s: swatches %s and %s are perceptually identical (dE=%.1f)",
						scene.name, got[i], got[j], labs[i].deltaE76(labs[j]))
				}
			}
		}
		for _, target := range scene.targets {
			totalTargets++
			targetLab := hexToLabTriplet(target)
			best := math.Inf(1)
			for _, lab := range labs {
				best = math.Min(best, lab.deltaE76(targetLab))
			}
			if best < 25 {
				hits++
			} else {
				t.Errorf("%s: subject colour (%v) missing, closest swatch is dE=%.1f away (palette %v)",
					scene.name, target, best, got)
			}
		}
		t.Logf("%-24s %v", scene.name, got)
	}
	if hits != totalTargets {
		t.Errorf("subject colours recovered: %d/%d", hits, totalTargets)
	}
}

// TestExtractDominantColorsNeverEmpty guards a nastier failure mode than a wrong
// palette: an empty card marks the asset as unfinished, so every later scan
// re-queues it for a thumbnail it can never produce.
func TestExtractDominantColorsNeverEmpty(t *testing.T) {
	cases := map[string]*image.NRGBA{
		"solid-black":  solidNRGBA(64, 64, color.NRGBA{0, 0, 0, 255}),
		"solid-white":  solidNRGBA(64, 64, color.NRGBA{255, 255, 255, 255}),
		"solid-grey":   solidNRGBA(64, 64, color.NRGBA{128, 128, 128, 255}),
		"transparent":  solidNRGBA(64, 64, color.NRGBA{0, 0, 0, 0}),
		"near-black":   solidNRGBA(64, 64, color.NRGBA{8, 6, 10, 255}),
		"near-white":   solidNRGBA(64, 64, color.NRGBA{252, 252, 250, 255}),
		"single-pixel": solidNRGBA(1, 1, color.NRGBA{20, 30, 40, 255}),
	}
	for name, img := range cases {
		if got := extractDominantColors(img, 5); len(got) == 0 {
			t.Errorf("%s: palette is empty, the asset would be re-queued forever", name)
		}
	}
}

func solidNRGBA(w, h int, c color.NRGBA) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetNRGBA(x, y, c)
		}
	}
	return img
}

func BenchmarkExtractDominantColors(b *testing.B) {
	scene := dominantColorScenes()[0].build()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		extractDominantColors(scene, 5)
	}
}

