package captcha

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"math"
)

// The local provider draws its own challenges instead of shipping bitmap assets:
// a self-hosted deployment must work offline, and a fixed asset set would be a
// searchable answer key within a week. Everything below is rasterised at three
// times the final resolution and box-filtered down, which is enough anti-aliasing
// for shapes and gradients without pulling an image-scaling dependency into the
// process.
//
// The images never contain the answer as text: a slider answer is a pixel offset,
// a click answer is a set of points and a select answer is a set of cell indexes.
// The browser gets pictures and geometry only; the expected answer stays in the
// challenge store.

const localSupersample = 3

// localPointF is a point in final-image coordinates.
type localPointF struct {
	X, Y float64
}

// localCanvas draws into a supersampled RGBA buffer.
type localCanvas struct {
	w, h int
	img  *image.RGBA
}

func newLocalCanvas(w, h int) *localCanvas {
	return &localCanvas{
		w:   w,
		h:   h,
		img: image.NewRGBA(image.Rect(0, 0, w*localSupersample, h*localSupersample)),
	}
}

func (c *localCanvas) fill(col color.RGBA) {
	for i := 0; i < len(c.img.Pix); i += 4 {
		c.img.Pix[i] = col.R
		c.img.Pix[i+1] = col.G
		c.img.Pix[i+2] = col.B
		c.img.Pix[i+3] = col.A
	}
}

// verticalGradient paints the whole canvas from top to bottom.
func (c *localCanvas) verticalGradient(top, bottom color.RGBA) {
	rows := c.img.Rect.Dy()
	for y := 0; y < rows; y++ {
		t := 0.0
		if rows > 1 {
			t = float64(y) / float64(rows-1)
		}
		col := color.RGBA{
			R: uint8(float64(top.R) + (float64(bottom.R)-float64(top.R))*t),
			G: uint8(float64(top.G) + (float64(bottom.G)-float64(top.G))*t),
			B: uint8(float64(top.B) + (float64(bottom.B)-float64(top.B))*t),
			A: 255,
		}
		offset := y * c.img.Stride
		for x := 0; x < c.img.Rect.Dx(); x++ {
			c.img.Pix[offset+x*4] = col.R
			c.img.Pix[offset+x*4+1] = col.G
			c.img.Pix[offset+x*4+2] = col.B
			c.img.Pix[offset+x*4+3] = col.A
		}
	}
}

// blendPixel composites col over one supersampled pixel.
func (c *localCanvas) blendPixel(x, y int, col color.RGBA) {
	if !(image.Point{X: x, Y: y}).In(c.img.Rect) {
		return
	}
	alpha := float64(col.A) / 255
	offset := c.img.PixOffset(x, y)
	pix := c.img.Pix[offset : offset+4]
	pix[0] = uint8(float64(col.R)*alpha + float64(pix[0])*(1-alpha) + 0.5)
	pix[1] = uint8(float64(col.G)*alpha + float64(pix[1])*(1-alpha) + 0.5)
	pix[2] = uint8(float64(col.B)*alpha + float64(pix[2])*(1-alpha) + 0.5)
}

// circle fills a disc in final-image coordinates.
func (c *localCanvas) circle(cx, cy, radius float64, col color.RGBA) {
	scale := float64(localSupersample)
	centerX, centerY, r := cx*scale, cy*scale, radius*scale
	r2 := r * r
	for y := int(math.Floor(centerY - r)); y <= int(math.Ceil(centerY+r)); y++ {
		for x := int(math.Floor(centerX - r)); x <= int(math.Ceil(centerX+r)); x++ {
			dx := float64(x) + 0.5 - centerX
			dy := float64(y) + 0.5 - centerY
			if dx*dx+dy*dy <= r2 {
				c.blendPixel(x, y, col)
			}
		}
	}
}

// rect fills an axis-aligned rectangle.
func (c *localCanvas) rect(x0, y0, x1, y1 float64, col color.RGBA) {
	scale := float64(localSupersample)
	for y := int(math.Floor(y0 * scale)); y <= int(math.Ceil(y1*scale)); y++ {
		for x := int(math.Floor(x0 * scale)); x <= int(math.Ceil(x1*scale)); x++ {
			c.blendPixel(x, y, col)
		}
	}
}

// polygon fills a simple polygon with the even-odd rule.
func (c *localCanvas) polygon(points []localPointF, col color.RGBA) {
	if len(points) < 3 {
		return
	}
	scale := float64(localSupersample)
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	scaled := make([]localPointF, len(points))
	for i, point := range points {
		scaled[i] = localPointF{X: point.X * scale, Y: point.Y * scale}
		minX = math.Min(minX, scaled[i].X)
		minY = math.Min(minY, scaled[i].Y)
		maxX = math.Max(maxX, scaled[i].X)
		maxY = math.Max(maxY, scaled[i].Y)
	}
	for y := int(math.Floor(minY)); y <= int(math.Ceil(maxY)); y++ {
		for x := int(math.Floor(minX)); x <= int(math.Ceil(maxX)); x++ {
			if pointInPolygon(float64(x)+0.5, float64(y)+0.5, scaled) {
				c.blendPixel(x, y, col)
			}
		}
	}
}

func pointInPolygon(x, y float64, points []localPointF) bool {
	inside := false
	previous := len(points) - 1
	for current := range points {
		pi, pj := points[current], points[previous]
		if (pi.Y > y) != (pj.Y > y) {
			crossX := (pj.X-pi.X)*(y-pi.Y)/(pj.Y-pi.Y) + pi.X
			if x < crossX {
				inside = !inside
			}
		}
		previous = current
	}
	return inside
}

// finish box-filters the supersampled buffer down to the final size.
func (c *localCanvas) finish() *image.RGBA {
	dst := image.NewRGBA(image.Rect(0, 0, c.w, c.h))
	samples := localSupersample * localSupersample
	for y := 0; y < c.h; y++ {
		for x := 0; x < c.w; x++ {
			var r, g, b, a int
			for dy := 0; dy < localSupersample; dy++ {
				for dx := 0; dx < localSupersample; dx++ {
					offset := c.img.PixOffset(x*localSupersample+dx, y*localSupersample+dy)
					r += int(c.img.Pix[offset])
					g += int(c.img.Pix[offset+1])
					b += int(c.img.Pix[offset+2])
					a += int(c.img.Pix[offset+3])
				}
			}
			offset := dst.PixOffset(x, y)
			dst.Pix[offset] = uint8(r / samples)
			dst.Pix[offset+1] = uint8(g / samples)
			dst.Pix[offset+2] = uint8(b / samples)
			dst.Pix[offset+3] = uint8(a / samples)
		}
	}
	return dst
}

// encodeLocalImage renders a PNG data URL, ready for an <img src>.
func encodeLocalImage(img image.Image) (string, error) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return "", err
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes()), nil
}

// extractLocalDisc copies a disc out of src so a slider can show the moving piece.
func extractLocalDisc(src *image.RGBA, centerX, centerY, radius int) *image.RGBA {
	size := radius * 2
	dst := image.NewRGBA(image.Rect(0, 0, size, size))
	r2 := float64(radius * radius)
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			dx := float64(x - radius)
			dy := float64(y - radius)
			if dx*dx+dy*dy > r2 {
				continue
			}
			dst.SetRGBA(x, y, src.RGBAAt(centerX-radius+x, centerY-radius+y))
		}
	}
	return dst
}

// darkenLocalDisc paints the socket the piece has to fill.
func darkenLocalDisc(src *image.RGBA, centerX, centerY, radius int, amount float64) {
	r2 := float64(radius * radius)
	for y := 0; y < src.Rect.Dy(); y++ {
		for x := 0; x < src.Rect.Dx(); x++ {
			dx := float64(x - centerX)
			dy := float64(y - centerY)
			if dx*dx+dy*dy > r2 {
				continue
			}
			pix := src.RGBAAt(x, y)
			keep := 1 - amount
			src.SetRGBA(x, y, color.RGBA{
				R: uint8(float64(pix.R) * keep),
				G: uint8(float64(pix.G) * keep),
				B: uint8(float64(pix.B) * keep),
				A: 255,
			})
		}
	}
}

// strokeLocalDisc draws a light outline around a disc at final resolution.
func strokeLocalDisc(src *image.RGBA, centerX, centerY, radius int, col color.RGBA) {
	outer := float64(radius) + 1.5
	inner := float64(radius) - 1.5
	for y := centerY - radius - 3; y <= centerY+radius+3; y++ {
		for x := centerX - radius - 3; x <= centerX+radius+3; x++ {
			if !(image.Point{X: x, Y: y}).In(src.Rect) {
				continue
			}
			dx := float64(x - centerX)
			dy := float64(y - centerY)
			d := math.Sqrt(dx*dx + dy*dy)
			if d <= outer && d >= inner {
				src.SetRGBA(x, y, col)
			}
		}
	}
}

// starPolygon builds the ten points of a five-pointed star.
func starPolygon(cx, cy, outer, inner float64) []localPointF {
	points := make([]localPointF, 0, 10)
	for i := 0; i < 10; i++ {
		radius := outer
		if i%2 == 1 {
			radius = inner
		}
		angle := -math.Pi/2 + float64(i)*math.Pi/5
		points = append(points, localPointF{
			X: cx + radius*math.Cos(angle),
			Y: cy + radius*math.Sin(angle),
		})
	}
	return points
}

// trianglePolygon is an upward triangle.
func trianglePolygon(cx, cy, radius float64) []localPointF {
	return []localPointF{
		{X: cx, Y: cy - radius},
		{X: cx + radius*0.92, Y: cy + radius*0.72},
		{X: cx - radius*0.92, Y: cy + radius*0.72},
	}
}

func diamondPolygon(cx, cy, radius float64) []localPointF {
	return []localPointF{
		{X: cx, Y: cy - radius},
		{X: cx + radius*0.8, Y: cy},
		{X: cx, Y: cy + radius},
		{X: cx - radius*0.8, Y: cy},
	}
}
