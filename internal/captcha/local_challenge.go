package captcha

import (
	"fmt"
	"image/color"
	"math"
	"sort"
)

// The local provider rotates three challenge kinds, one per request:
//
//   - slider: drag a circular piece into the socket cut out of the scene;
//   - click:  click every star in a picture full of decoy shapes;
//   - select: pick the grid cells that contain a circle.
//
// Each kind asks for a different interaction, so a script that defeated one (a
// naive form filler, an OCR of a text question) still has to solve a pointing
// task. None of them is a hard captcha: this provider exists for offline and
// privacy-first deployments, and the package documentation says so.
const (
	localSliderWidth     = 320
	localSliderHeight    = 180
	localSliderPiece     = 52
	localSliderMargin    = 24
	localSliderTopMargin = 16
	// localSliderTolerance is how far the dropped piece may be from the socket,
	// in picture pixels. Six pixels is well under the socket radius, so the piece
	// visibly overlaps the notch before the answer counts.
	localSliderTolerance = 6

	localClickWidth     = 320
	localClickHeight    = 200
	localClickMargin    = 30
	localClickSpacing   = 44
	localClickTolerance = 26

	localSelectCell   = 96
	localSelectCols   = 3
	localSelectRows   = 3
	localSelectRadius = 26
)

// Prompts are shown below the picture. The frontend translates its own copy of
// these sentences; the server sends them for any other client.
const (
	localPromptSlider = "拖动滑块，把圆形拼图移到缺口处。"
	localPromptClick  = "点击图中的所有星星（共 %d 个）。"
	localPromptSelect = "选择所有包含圆形的图片（共 %d 张）。"
)

// localShapePalette is the figure fill palette. The tones stay saturated and dark
// enough to stand out on both the pastel select tiles and the click backdrop.
var localShapePalette = []color.RGBA{
	{R: 0xE0, G: 0x4A, B: 0x4A, A: 255},
	{R: 0x2F, G: 0x6F, B: 0xE8, A: 255},
	{R: 0x14, G: 0x9C, B: 0x6C, A: 255},
	{R: 0xE4, G: 0x8B, B: 0x1F, A: 255},
	{R: 0x7A, G: 0x5C, B: 0xE0, A: 255},
	{R: 0x0E, G: 0x7C, B: 0x93, A: 255},
	{R: 0xC7, G: 0x3D, B: 0x6B, A: 255},
	{R: 0x3B, G: 0x4F, B: 0xB5, A: 255},
}

// localCellBackgrounds are the painted tiles of the select grid: warm paper
// tones rather than a single flat grey, so adjacent cells read as separate cards.
var localCellBackgrounds = []color.RGBA{
	{R: 0xF6, G: 0xE7, B: 0xD5, A: 255},
	{R: 0xDD, G: 0xEC, B: 0xF5, A: 255},
	{R: 0xE4, G: 0xF0, B: 0xE0, A: 255},
	{R: 0xF3, G: 0xE3, B: 0xEE, A: 255},
	{R: 0xEF, G: 0xEB, B: 0xDD, A: 255},
	{R: 0xE8, G: 0xE6, B: 0xF7, A: 255},
	{R: 0xF7, G: 0xE9, B: 0xE1, A: 255},
}

// localFlowerPalette dots the meadow of the slider scene. The colours are the
// only decoration drawn on grass, so they stay warm and light.
var localFlowerPalette = []color.RGBA{
	{R: 0xF2, G: 0x7D, B: 0x9A, A: 255},
	{R: 0xF6, G: 0xC0, B: 0x4B, A: 255},
	{R: 0xC9, G: 0x8B, B: 0xE0, A: 255},
	{R: 0xFF, G: 0xF6, B: 0xE0, A: 255},
}

// The decoy shapes for the select kind. A circle is deliberately absent: it is
// the target, and a decoy circle would make the task unanswerable.
var localSelectDecoys = []string{"square", "triangle", "star", "diamond", "plus"}

// The decoy shapes for the click kind. A star is deliberately absent for the
// same reason: "click every star" must not be ambiguous, or the visitor is
// punished for a picture the server drew.
var localClickDecoys = []string{"square", "triangle", "diamond", "plus", "circle"}

// generateLocalChallenge renders one challenge of kind and returns the answer the
// store has to keep. The answer never travels in the challenge payload.
func generateLocalChallenge(kind LocalKind, scene Scene) (LocalChallenge, LocalAnswer, error) {
	switch kind {
	case LocalKindSlider:
		return generateLocalSlider()
	case LocalKindClick:
		return generateLocalClick()
	case LocalKindSelect:
		return generateLocalSelect()
	default:
		return LocalChallenge{}, LocalAnswer{}, fmt.Errorf("unknown local challenge kind %q", kind)
	}
}

func generateLocalSlider() (LocalChallenge, LocalAnswer, error) {
	pieceRadius := localSliderPiece / 2
	targetX, err := randBetween(localSliderMargin, localSliderWidth-localSliderPiece-localSliderMargin)
	if err != nil {
		return LocalChallenge{}, LocalAnswer{}, err
	}
	targetY, err := randBetween(localSliderTopMargin, localSliderHeight-localSliderPiece-localSliderTopMargin)
	if err != nil {
		return LocalChallenge{}, LocalAnswer{}, err
	}

	canvas := newLocalCanvas(localSliderWidth, localSliderHeight)
	if err := paintLocalSliderScene(canvas); err != nil {
		return LocalChallenge{}, LocalAnswer{}, err
	}
	sceneImage := canvas.finish()

	centerX, centerY := targetX+pieceRadius, targetY+pieceRadius
	piece := extractLocalDisc(sceneImage, centerX, centerY, pieceRadius)
	darkenLocalDisc(sceneImage, centerX, centerY, pieceRadius, 0.55)
	strokeLocalDisc(sceneImage, centerX, centerY, pieceRadius, color.NRGBA{R: 0xFF, G: 0xFF, B: 0xFF, A: 235})
	strokeLocalDisc(piece, pieceRadius, pieceRadius, pieceRadius, color.NRGBA{R: 0xFF, G: 0xFF, B: 0xFF, A: 235})

	background, err := encodeLocalImage(sceneImage)
	if err != nil {
		return LocalChallenge{}, LocalAnswer{}, fmt.Errorf("encode slider background: %w", err)
	}
	pieceURL, err := encodeLocalImage(piece)
	if err != nil {
		return LocalChallenge{}, LocalAnswer{}, fmt.Errorf("encode slider piece: %w", err)
	}

	answerX := targetX
	return LocalChallenge{
		Kind:       LocalKindSlider,
		Prompt:     localPromptSlider,
		Width:      localSliderWidth,
		Height:     localSliderHeight,
		Background: background,
		Piece:      pieceURL,
		PieceSize:  localSliderPiece,
		PieceTop:   targetY,
		MaxOffset:  localSliderWidth - localSliderPiece,
	}, LocalAnswer{X: &answerX}, nil
}

// paintLocalSliderScene layers the landscape behind the socket: sky, sun, clouds,
// mountain ridges, hills, meadow and flowers, plus a few birds. Every accent is
// drawn from the same crypto RNG as the answer, so no two challenges share a
// picture, and none of it moves the socket: the caller cuts that out at the answer
// coordinates after this returns.
func paintLocalSliderScene(c *localCanvas) error {
	c.gradient(
		localGradientStop{Offset: 0, Color: color.RGBA{R: 0x6C, G: 0xA6, B: 0xE2, A: 255}},
		localGradientStop{Offset: 0.5, Color: color.RGBA{R: 0xB9, G: 0xDD, B: 0xF4, A: 255}},
		localGradientStop{Offset: 0.78, Color: color.RGBA{R: 0xE8, G: 0xEF, B: 0xE2, A: 255}},
		localGradientStop{Offset: 1, Color: color.RGBA{R: 0xFB, G: 0xE8, B: 0xCB, A: 255}},
	)

	sunX, err := randBetween(44, localSliderWidth-44)
	if err != nil {
		return err
	}
	sunY, err := randBetween(26, 62)
	if err != nil {
		return err
	}
	// Nested translucent discs read as a radial glow after the supersampled
	// downscale; a blur pass would need a dependency the offline build does not want.
	c.circle(float64(sunX), float64(sunY), 33, color.RGBA{R: 0xFF, G: 0xE6, B: 0xAE, A: 24})
	c.circle(float64(sunX), float64(sunY), 27, color.RGBA{R: 0xFF, G: 0xE8, B: 0xB4, A: 32})
	c.circle(float64(sunX), float64(sunY), 22, color.RGBA{R: 0xFF, G: 0xE4, B: 0xA6, A: 42})
	c.circle(float64(sunX), float64(sunY), 18, color.RGBA{R: 0xFF, G: 0xD3, B: 0x78, A: 255})
	c.circle(float64(sunX-6), float64(sunY-6), 6.5, color.RGBA{R: 0xFF, G: 0xF2, B: 0xCC, A: 235})

	clouds, err := randBetween(2, 3)
	if err != nil {
		return err
	}
	for index := 0; index < clouds; index++ {
		cloudX, err := randBetween(18, localSliderWidth-112)
		if err != nil {
			return err
		}
		cloudY, err := randBetween(20, 76)
		if err != nil {
			return err
		}
		white := color.RGBA{R: 0xFF, G: 0xFF, B: 0xFF, A: uint8(168 + index*14)}
		c.circle(float64(cloudX), float64(cloudY), 12, white)
		c.circle(float64(cloudX+15), float64(cloudY-7), 16, white)
		c.circle(float64(cloudX+34), float64(cloudY-2), 13, white)
		c.circle(float64(cloudX+48), float64(cloudY+3), 9, white)
		c.roundedRect(float64(cloudX-2), float64(cloudY+2), float64(cloudX+56), float64(cloudY+11), 6, white)
	}

	// Two mountain layers: the far range is paler, the near range carries a snow
	// cap. The ridges sit low so the socket area stays a calm field of colour.
	ranges := []struct {
		base  float64
		color color.RGBA
		snow  color.RGBA
	}{
		{
			base:  148,
			color: color.RGBA{R: 0xA6, G: 0xBB, B: 0xD6, A: 255},
			snow:  color.RGBA{R: 0xFF, G: 0xFF, B: 0xFF, A: 138},
		},
		{
			base:  156,
			color: color.RGBA{R: 0x8B, G: 0xA6, B: 0xC7, A: 255},
			snow:  color.RGBA{R: 0xF6, G: 0xFA, B: 0xFF, A: 120},
		},
	}
	for _, layer := range ranges {
		peaks, err := randBetween(3, 4)
		if err != nil {
			return err
		}
		segment := (float64(localSliderWidth) + 24) / float64(peaks)
		type localPeak struct{ x, y float64 }
		peaksSeen := make([]localPeak, 0, peaks)
		ridge := []localPointF{{X: -12, Y: layer.base}}
		for index := 0; index < peaks; index++ {
			startX := -12 + float64(index)*segment
			peakHeight, err := randBetween(20, 44)
			if err != nil {
				return err
			}
			// Keep the summit somewhere in the middle third of its segment: at the
			// edges the ridge would climb too steeply to read as a mountain range.
			shaft, err := randBetween(35, 65)
			if err != nil {
				return err
			}
			peakX := startX + segment*float64(shaft)/100
			peakY := layer.base - float64(peakHeight)
			peaksSeen = append(peaksSeen, localPeak{x: peakX, y: peakY})
			ridge = append(ridge, localPointF{X: peakX, Y: peakY})
			valleyDepth, err := randBetween(4, 14)
			if err != nil {
				return err
			}
			ridge = append(ridge, localPointF{
				X: startX + segment*0.92,
				Y: layer.base - float64(valleyDepth),
			})
		}
		ridge = append(ridge, localPointF{X: float64(localSliderWidth) + 12, Y: layer.base})
		c.polygon(ridge, layer.color)

		for _, peak := range peaksSeen {
			capHeight := 15.0
			c.polygon([]localPointF{
				{X: peak.x, Y: peak.y},
				{X: peak.x - capHeight*0.78, Y: peak.y + capHeight},
				{X: peak.x + capHeight*0.78, Y: peak.y + capHeight},
			}, layer.snow)
		}
	}

	// Rolling hills in three greens, plus a lighter meadow strip at the bottom.
	c.circle(float64(localSliderWidth*26/100), float64(localSliderHeight+24), 96,
		color.RGBA{R: 0x86, G: 0xB5, B: 0x6E, A: 255})
	c.circle(float64(localSliderWidth*83/100), float64(localSliderHeight+40), 120,
		color.RGBA{R: 0x69, G: 0x9C, B: 0x59, A: 255})
	c.circle(float64(localSliderWidth*55/100), float64(localSliderHeight+46), 76,
		color.RGBA{R: 0x77, G: 0xA8, B: 0x60, A: 255})
	c.circle(float64(localSliderWidth*5/100), float64(localSliderHeight+8), 62,
		color.RGBA{R: 0x9A, G: 0xC1, B: 0x7A, A: 255})
	c.roundedRect(-12, 166, float64(localSliderWidth)+12, float64(localSliderHeight)+12, 22,
		color.RGBA{R: 0x7C, G: 0xAB, B: 0x5F, A: 255})

	flowers, err := randBetween(5, 8)
	if err != nil {
		return err
	}
	for index := 0; index < flowers; index++ {
		flowerX, err := randBetween(12, localSliderWidth-12)
		if err != nil {
			return err
		}
		flowerY, err := randBetween(164, localSliderHeight-7)
		if err != nil {
			return err
		}
		petal, err := pickLocalColor(localFlowerPalette)
		if err != nil {
			return err
		}
		petalRadius, err := randBetween(18, 26)
		if err != nil {
			return err
		}
		radius := float64(petalRadius) / 10
		for step := 0; step < 4; step++ {
			angle := float64(step)*math.Pi/2 + 0.4
			c.circle(
				float64(flowerX)+math.Cos(angle)*radius*1.35,
				float64(flowerY)+math.Sin(angle)*radius*1.35,
				radius, petal,
			)
		}
		c.circle(float64(flowerX), float64(flowerY), radius*0.7,
			color.RGBA{R: 0xFF, G: 0xF3, B: 0xC4, A: 255})
	}

	birds, err := randBetween(1, 3)
	if err != nil {
		return err
	}
	for index := 0; index < birds; index++ {
		birdX, err := randBetween(30, localSliderWidth-40)
		if err != nil {
			return err
		}
		birdY, err := randBetween(24, 76)
		if err != nil {
			return err
		}
		wing, err := randBetween(5, 8)
		if err != nil {
			return err
		}
		span := float64(wing)
		bird := color.RGBA{R: 0x3E, G: 0x55, B: 0x6B, A: 132}
		for _, direction := range []float64{-1, 1} {
			c.polygon([]localPointF{
				{X: float64(birdX), Y: float64(birdY)},
				{X: float64(birdX) + direction*span, Y: float64(birdY) - span*0.55},
				{X: float64(birdX) + direction*span*0.78, Y: float64(birdY) + span*0.16},
			}, bird)
		}
	}
	return nil
}

func generateLocalClick() (LocalChallenge, LocalAnswer, error) {
	targetCount, err := randBetween(3, 4)
	if err != nil {
		return LocalChallenge{}, LocalAnswer{}, err
	}
	decoyCount, err := randBetween(4, 5)
	if err != nil {
		return LocalChallenge{}, LocalAnswer{}, err
	}

	// One layout for both targets and decoys keeps them apart: a star hidden
	// behind a decoy square would be unclickable.
	shapes, err := placeLocalPoints(targetCount+decoyCount,
		localClickWidth, localClickHeight, localClickMargin, localClickSpacing)
	if err != nil {
		return LocalChallenge{}, LocalAnswer{}, err
	}
	targets := shapes[:targetCount]
	decoys := shapes[targetCount:]

	canvas := newLocalCanvas(localClickWidth, localClickHeight)
	if err := paintLocalClickBackdrop(canvas, localClickWidth, localClickHeight); err != nil {
		return LocalChallenge{}, LocalAnswer{}, err
	}

	for _, decoy := range decoys {
		shape, err := pickLocalString(localClickDecoys)
		if err != nil {
			return LocalChallenge{}, LocalAnswer{}, err
		}
		col, err := pickLocalColor(localShapePalette)
		if err != nil {
			return LocalChallenge{}, LocalAnswer{}, err
		}
		drawLocalShape(canvas, shape, float64(decoy.X), float64(decoy.Y), 15, col)
	}
	starColor, err := pickLocalColor(localShapePalette)
	if err != nil {
		return LocalChallenge{}, LocalAnswer{}, err
	}
	for _, target := range targets {
		tx, ty := float64(target.X), float64(target.Y)
		canvas.polygon(starPolygon(tx, ty+2.2, 18.4, 8.6),
			color.RGBA{R: 0xFF, G: 0xFF, B: 0xFF, A: 205})
		canvas.polygon(starPolygon(tx+0.8, ty+3, 17, 8),
			color.RGBA{R: 0x1F, G: 0x2A, B: 0x37, A: 52})
		canvas.polygon(starPolygon(tx, ty, 17, 8), starColor)
	}

	picture, err := encodeLocalImage(canvas.finish())
	if err != nil {
		return LocalChallenge{}, LocalAnswer{}, fmt.Errorf("encode click picture: %w", err)
	}

	return LocalChallenge{
		Kind:        LocalKindClick,
		Prompt:      fmt.Sprintf(localPromptClick, targetCount),
		Width:       localClickWidth,
		Height:      localClickHeight,
		Image:       picture,
		TargetCount: targetCount,
	}, LocalAnswer{Points: targets}, nil
}

// paintLocalClickBackdrop paints the paper behind the click figures: a three-stop
// wash, four translucent colour blooms, a frosted panel, a faint dot lattice and two
// wide rings. The texture is deliberately soft: the decoys include a circle, so a
// crisp background circle would look like another figure.
func paintLocalClickBackdrop(c *localCanvas, width, height int) error {
	c.gradient(
		localGradientStop{Offset: 0, Color: color.RGBA{R: 0xE9, G: 0xEE, B: 0xF8, A: 255}},
		localGradientStop{Offset: 0.55, Color: color.RGBA{R: 0xF7, G: 0xEF, B: 0xE5, A: 255}},
		localGradientStop{Offset: 1, Color: color.RGBA{R: 0xEC, G: 0xF2, B: 0xE6, A: 255}},
	)

	blooms := []color.RGBA{
		{R: 0x9F, G: 0xC4, B: 0xF0, A: 54},
		{R: 0xF2, G: 0xC9, B: 0xA8, A: 48},
		{R: 0xAF, G: 0xD8, B: 0xC2, A: 46},
		{R: 0xD8, G: 0xBF, B: 0xEC, A: 42},
	}
	for _, bloom := range blooms {
		bloomX, err := randBetween(0, width)
		if err != nil {
			return err
		}
		bloomY, err := randBetween(0, height)
		if err != nil {
			return err
		}
		radius, err := randBetween(42, 92)
		if err != nil {
			return err
		}
		c.circle(float64(bloomX), float64(bloomY), float64(radius), bloom)
	}

	// The frosted panel keeps the dots and rings from reading as part of the wash.
	c.roundedRect(10, 10, float64(width)-10, float64(height)-10, 22,
		color.RGBA{R: 0xFF, G: 0xFF, B: 0xFF, A: 34})

	for y := 26; y < height; y += 29 {
		for x := 24; x < width; x += 29 {
			c.circle(float64(x), float64(y), 1.5, color.RGBA{R: 0xFF, G: 0xFF, B: 0xFF, A: 62})
		}
	}

	rings, err := randBetween(1, 2)
	if err != nil {
		return err
	}
	for index := 0; index < rings; index++ {
		ringX, err := randBetween(20, width-20)
		if err != nil {
			return err
		}
		ringY, err := randBetween(20, height-20)
		if err != nil {
			return err
		}
		radius, err := randBetween(46, 86)
		if err != nil {
			return err
		}
		c.ring(float64(ringX), float64(ringY), float64(radius), 2,
			color.RGBA{R: 0xFF, G: 0xFF, B: 0xFF, A: 58})
	}
	return nil
}

func generateLocalSelect() (LocalChallenge, LocalAnswer, error) {
	targetCount, err := randBetween(3, 4)
	if err != nil {
		return LocalChallenge{}, LocalAnswer{}, err
	}
	cells := localSelectRows * localSelectCols
	order, err := randomPermutation(cells)
	if err != nil {
		return LocalChallenge{}, LocalAnswer{}, err
	}
	targets := append([]int(nil), order[:targetCount]...)
	sort.Ints(targets)

	width := localSelectCols * localSelectCell
	height := localSelectRows * localSelectCell
	canvas := newLocalCanvas(width, height)
	canvas.gradient(
		localGradientStop{Offset: 0, Color: color.RGBA{R: 0xE4, G: 0xE9, B: 0xF3, A: 255}},
		localGradientStop{Offset: 0.55, Color: color.RGBA{R: 0xF3, G: 0xEF, B: 0xE6, A: 255}},
		localGradientStop{Offset: 1, Color: color.RGBA{R: 0xE8, G: 0xF1, B: 0xE7, A: 255}},
	)

	for row := 0; row < localSelectRows; row++ {
		for col := 0; col < localSelectCols; col++ {
			index := row*localSelectCols + col
			x0 := float64(col * localSelectCell)
			y0 := float64(row * localSelectCell)
			right := x0 + localSelectCell
			bottom := y0 + localSelectCell
			background, err := pickLocalColor(localCellBackgrounds)
			if err != nil {
				return LocalChallenge{}, LocalAnswer{}, err
			}
			// The same layered card treatment the form UI uses: a soft drop shadow,
			// a white rim, then the tinted panel with a highlight along its top.
			canvas.roundedRect(x0+5, y0+6, right-1, bottom-1, 17,
				color.RGBA{R: 0x1F, G: 0x2A, B: 0x37, A: 30})
			canvas.roundedRect(x0+3, y0+3, right-3, bottom-3, 16,
				color.RGBA{R: 0xFF, G: 0xFF, B: 0xFF, A: 148})
			canvas.roundedRect(x0+5, y0+5, right-5, bottom-5, 14, background)
			canvas.roundedRect(x0+10, y0+9, right-10, y0+19, 5,
				color.RGBA{R: 0xFF, G: 0xFF, B: 0xFF, A: 96})

			centerX := x0 + localSelectCell/2
			centerY := y0 + localSelectCell/2
			shape := "circle"
			if !containsLocalInt(targets, index) {
				shape, err = pickLocalString(localSelectDecoys)
				if err != nil {
					return LocalChallenge{}, LocalAnswer{}, err
				}
			}
			shapeColor, err := pickLocalColor(localShapePalette)
			if err != nil {
				return LocalChallenge{}, LocalAnswer{}, err
			}
			drawLocalShape(canvas, shape, centerX, centerY, localSelectRadius, shapeColor)
		}
	}

	picture, err := encodeLocalImage(canvas.finish())
	if err != nil {
		return LocalChallenge{}, LocalAnswer{}, fmt.Errorf("encode select picture: %w", err)
	}

	return LocalChallenge{
		Kind:        LocalKindSelect,
		Prompt:      fmt.Sprintf(localPromptSelect, targetCount),
		Width:       width,
		Height:      height,
		Image:       picture,
		Rows:        localSelectRows,
		Cols:        localSelectCols,
		TargetCount: targetCount,
	}, LocalAnswer{Tiles: targets}, nil
}

// drawLocalShape paints one of the geometric figures the challenges use.
//
// A pale halo and a soft shadow are laid down before the fill, which lifts the
// figure off the painted paper and matches the card treatment of the rest of the
// interface. Neither decoration changes the shape: a target and a decoy differ
// only in colour and geometry, never in silhouette.
func drawLocalShape(c *localCanvas, shape string, cx, cy, radius float64, col color.RGBA) {
	fillLocalShape(c, shape, cx, cy, radius*1.14,
		color.RGBA{R: 0xFF, G: 0xFF, B: 0xFF, A: 205})
	fillLocalShape(c, shape, cx+radius*0.05, cy+radius*0.14, radius,
		color.RGBA{R: 0x1F, G: 0x2A, B: 0x37, A: 52})
	fillLocalShape(c, shape, cx, cy, radius, col)
}

// fillLocalShape rasterises one figure without any decoration.
func fillLocalShape(c *localCanvas, shape string, cx, cy, radius float64, col color.RGBA) {
	switch shape {
	case "circle":
		c.circle(cx, cy, radius, col)
	case "square":
		c.rect(cx-radius*0.82, cy-radius*0.82, cx+radius*0.82, cy+radius*0.82, col)
	case "triangle":
		c.polygon(trianglePolygon(cx, cy, radius), col)
	case "diamond":
		c.polygon(diamondPolygon(cx, cy, radius), col)
	case "star":
		c.polygon(starPolygon(cx, cy, radius, radius*0.45), col)
	case "plus":
		arm := radius * 0.32
		c.rect(cx-radius, cy-arm, cx+radius, cy+arm, col)
		c.rect(cx-arm, cy-radius, cx+arm, cy+radius, col)
	}
}

// placeLocalPoints picks count points on a jittered grid.
//
// A grid guarantees the minimum distance between shapes (and therefore that the
// renderer never produces an unsolvable overlap); the random cell order and the
// jitter keep the result from looking like a lattice. Rejection sampling was the
// obvious alternative, but with ten shapes in a 320x200 picture it regularly ran
// out of room.
func placeLocalPoints(count, width, height, margin, spacing int) ([]LocalPoint, error) {
	usableWidth := width - 2*margin
	usableHeight := height - 2*margin
	cols := usableWidth / spacing
	rows := usableHeight / spacing
	if cols < 1 || rows < 1 {
		return nil, fmt.Errorf("no room for %d shapes", count)
	}
	if count > cols*rows {
		return nil, fmt.Errorf("no room for %d shapes in a %dx%d grid", count, cols, rows)
	}
	cellWidth := usableWidth / cols
	cellHeight := usableHeight / rows
	jitterX := cellWidth - spacing
	jitterY := cellHeight - spacing

	order, err := randomPermutation(cols * rows)
	if err != nil {
		return nil, err
	}
	points := make([]LocalPoint, 0, count)
	for _, cell := range order[:count] {
		col := cell % cols
		row := cell / cols
		dx, err := randBetween(-jitterX/2, jitterX/2)
		if err != nil {
			return nil, err
		}
		dy, err := randBetween(-jitterY/2, jitterY/2)
		if err != nil {
			return nil, err
		}
		points = append(points, LocalPoint{
			X: margin + col*cellWidth + cellWidth/2 + dx,
			Y: margin + row*cellHeight + cellHeight/2 + dy,
		})
	}
	return points, nil
}

func pickLocalColor(palette []color.RGBA) (color.RGBA, error) {
	index, err := randBetween(0, len(palette)-1)
	if err != nil {
		return color.RGBA{}, err
	}
	return palette[index], nil
}

func pickLocalString(values []string) (string, error) {
	index, err := randBetween(0, len(values)-1)
	if err != nil {
		return "", err
	}
	return values[index], nil
}

func containsLocalInt(values []int, wanted int) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

// randomPermutation returns the integers [0, n) in random order (Fisher-Yates).
func randomPermutation(n int) ([]int, error) {
	order := make([]int, n)
	for i := range order {
		order[i] = i
	}
	for i := n - 1; i > 0; i-- {
		j, err := randBetween(0, i)
		if err != nil {
			return nil, err
		}
		order[i], order[j] = order[j], order[i]
	}
	return order, nil
}
