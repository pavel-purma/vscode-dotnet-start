param(
  [int]$Width = 256,
  [int]$Height = 256,
  [string]$OutputPath = "media\\icon.png",
  [string]$Background = "#563DCC",
  [int]$TextY = 30,
  [int]$PlayCenterXOffset = 6,
  [int]$PlayCenterY = 194,
  [int]$PlayHalfHeight = 26
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$bmp = New-Object System.Drawing.Bitmap $Width, $Height
$g = [System.Drawing.Graphics]::FromImage($bmp)

try {
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

  $bg = [System.Drawing.ColorTranslator]::FromHtml($Background)
  $g.Clear($bg)

  $whiteBrush = [System.Drawing.Brushes]::White

  # .NET text
  $text = '.NET'
  $font = New-Object System.Drawing.Font('Segoe UI', 96, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel))
  $size = $g.MeasureString($text, $font)
  $x = [Math]::Max(0, ($Width - $size.Width) / 2)
  $g.DrawString($text, $font, $whiteBrush, [single]$x, [single]$TextY)

  # Play triangle (optically centered by shifting right)
  $triCenterX = ($Width / 2) + $PlayCenterXOffset
  $triCenterY = $PlayCenterY

  $triLeftX = $triCenterX - 36
  $triRightX = $triCenterX + 28
  $triTopY = $triCenterY - $PlayHalfHeight
  $triBotY = $triCenterY + $PlayHalfHeight

  $points = New-Object System.Drawing.PointF[] 3
  $points[0] = New-Object System.Drawing.PointF([single]$triLeftX, [single]$triTopY)
  $points[1] = New-Object System.Drawing.PointF([single]$triLeftX, [single]$triBotY)
  $points[2] = New-Object System.Drawing.PointF([single]$triRightX, [single]$triCenterY)

  $g.FillPolygon($whiteBrush, $points)

  $dir = Split-Path -Parent $OutputPath
  if ($dir -and !(Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir | Out-Null
  }

  $bmp.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Host "Wrote $OutputPath"
}
finally {
  if ($g) { $g.Dispose() }
  if ($bmp) { $bmp.Dispose() }
}
