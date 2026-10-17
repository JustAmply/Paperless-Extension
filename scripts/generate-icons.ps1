$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assetDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\assets'))
$sourceImage = [System.Drawing.Image]::FromFile((Join-Path $assetDirectory 'icon-source.png'))
try {
    foreach ($size in 16, 32, 48, 128) {
        $bitmap = [System.Drawing.Bitmap]::new($size, $size)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.DrawImage($sourceImage, 0, 0, $size, $size)
            $bitmap.Save((Join-Path $assetDirectory "icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $graphics.Dispose()
            $bitmap.Dispose()
        }
    }
} finally {
    $sourceImage.Dispose()
}
