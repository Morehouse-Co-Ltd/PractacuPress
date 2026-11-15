package captcha

import (
	"fmt"
	"image/color"
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

var localShapePalette = []color.RGBA{
	{R: 0xE0, G: 0x4A, B: 0x4A, A: 255},
	{R: 0x2F, G: 0x6F, B: 0xE8, A: 255},
	{R: 0x14, G: 0x9C, B: 0x6C, A: 255},
	{R: 0xE4, G: 0x8B, B: 0x1F, A: 255},
	{R: 0x7A, G: 0x5C, B: 0xE0, A: 255},
	{R: 0x0E, G: 0x7C, B: 0x93, A: 255},
}

var localCellBackgrounds = []color.RGBA{
	{R: 0xF6, G: 0xE7, B: 0xD5, A: 255},
	{R: 0xDD, G: 0xEC, B: 0xF5, A: 255},
	{R: 0xE4, G: 0xF0, B: 0xE0, A: 255},
	{R: 0xF3, G: 0xE3, B: 0xEE, A: 255},
	{R: 0xEF, G: 0xEB, B: 0xDD, A: 255},
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
	strokeLocalDisc(sceneImage, centerX, centerY, pieceRadius, color.RGBA{R: 0xFF, G: 0xFF, B: 0xFF, A: 235})
	strokeLocalDisc(piece, pieceRadius, pieceRadius, pieceRadius, color.RGBA{R: 0xFF, G: 0xFF, B: 0xFF, A: 235})

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

func paintLocalSliderScene(c *localCanvas) error {
	c.verticalGradient(
		color.RGBA{R: 0x9F, G: 0xCB, B: 0xE8, A: 255},
		color.RGBA{R: 0xFB, G: 0xE7, B: 0xCB, A: 255},
	)

	sunX, err := randBetween(48, localSliderWidth-48)
	if err != nil {
		return err
	}
	sunY, err := randBetween(28, 62)
	if err != nil {
		return err
	}
	c.circle(float64(sunX), float64(sunY), 22, color.RGBA{R: 0xFF, G: 0xD5, B: 0x8A, A: 255})

	for i := 0; i < 2; i++ {
		cloudX, err := randBetween(36, localSliderWidth-96)
		if err != nil {
			return err
		}
		cloudY, err := randBetween(20, 74)
		if err != nil {
			return err
		}
		white := color.RGBA{R: 0xFF, G: 0xFF, B: 0xFF, A: 190}
		c.circle(float64(cloudX), float64(cloudY), 13, white)
		c.circle(float64(cloudX+16), float64(cloudY-6), 17, white)
		c.circle(float64(cloudX+34), float64(cloudY), 12, white)
	}

	c.circle(float64(localSliderWidth*28/100), float64(localSliderHeight+28), 92,
		color.RGBA{R: 0x7C, G: 0xAE, B: 0x69, A: 255})
	c.circle(float64(localSliderWidth*84/100), float64(localSliderHeight+44), 118,
		color.RGBA{R: 0x5C, G: 0x93, B: 0x55, A: 255})
	c.circle(float64(localSliderWidth*57/100), float64(localSliderHeight+52), 74,
		color.RGBA{R: 0x6D, G: 0xA0, B: 0x5B, A: 255})
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
	canvas.verticalGradient(
		color.RGBA{R: 0xE9, G: 0xEE, B: 0xF8, A: 255},
		color.RGBA{R: 0xF9, G: 0xEF, B: 0xE2, A: 255},
	)
	for i := 0; i < 3; i++ {
		bubbleX, err := randBetween(0, localClickWidth)
		if err != nil {
			return LocalChallenge{}, LocalAnswer{}, err
		}
		bubbleY, err := randBetween(0, localClickHeight)
		if err != nil {
			return LocalChallenge{}, LocalAnswer{}, err
		}
		radius, err := randBetween(40, 80)
		if err != nil {
			return LocalChallenge{}, LocalAnswer{}, err
		}
		canvas.circle(float64(bubbleX), float64(bubbleY), float64(radius),
			color.RGBA{R: 0xFF, G: 0xFF, B: 0xFF, A: 46})
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
		canvas.polygon(starPolygon(float64(target.X), float64(target.Y), 17, 8), starColor)
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
	canvas.fill(color.RGBA{R: 0xE3, G: 0xE8, B: 0xEF, A: 255})

	for row := 0; row < localSelectRows; row++ {
		for col := 0; col < localSelectCols; col++ {
			index := row*localSelectCols + col
			x0 := float64(col * localSelectCell)
			y0 := float64(row * localSelectCell)
			background, err := pickLocalColor(localCellBackgrounds)
			if err != nil {
				return LocalChallenge{}, LocalAnswer{}, err
			}
			canvas.rect(x0+3, y0+3, x0+localSelectCell-3, y0+localSelectCell-3, background)

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
func drawLocalShape(c *localCanvas, shape string, cx, cy, radius float64, col color.RGBA) {
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
