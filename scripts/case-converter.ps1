# case-converter.ps1
# GUI launcher untuk scripts/docx-to-case.js
# Buka file picker -> pilih .docx -> pilih kategori -> jalankan converter otomatis

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ── Sembunyikan jendela console PowerShell ────────────────────────────────
Add-Type -Name Win32 -Namespace Console -MemberDefinition '
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'
$consoleHwnd = [Console.Win32]::GetConsoleWindow()
if ($consoleHwnd -ne [IntPtr]::Zero) {
    [Console.Win32]::ShowWindow($consoleHwnd, 0) | Out-Null   # 0 = SW_HIDE
}

# ── Cari root project (script ini ada di scripts/, root-nya satu tingkat di atas) ─
$scriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$converterJs = Join-Path $scriptDir "docx-to-case.js"

# ── Cek Node.js tersedia ──────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    [System.Windows.Forms.MessageBox]::Show(
        "Node.js tidak ditemukan. Install dulu dari https://nodejs.org",
        "Case Converter — Error",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    )
    exit 1
}

if (-not (Test-Path $converterJs)) {
    [System.Windows.Forms.MessageBox]::Show(
        "scripts/docx-to-case.js tidak ditemukan. Pastikan file ini ada di folder yang sama.",
        "Case Converter — Error",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    )
    exit 1
}

# ── Daftar kategori: baca folder yang sudah ada di data/cases, plus default ─
$defaultKategori = @(
    "endokrin", "gastro", "genitourinaria", "hematoimun", "integumen",
    "kardio", "mata", "muskuloskeletal", "neurologi", "psikiatri", "tht"
)
$casesDir = Join-Path $projectRoot "data\cases"
$existingKategori = @()
if (Test-Path $casesDir) {
    $existingKategori = Get-ChildItem -Path $casesDir -Directory | Select-Object -ExpandProperty Name
}
$kategoriList = ($defaultKategori + $existingKategori) | Sort-Object -Unique

# ── Buat form utama ───────────────────────────────────────────────────────
$form = New-Object System.Windows.Forms.Form
$form.Text = "Compos-Mentis — Case Converter"
$form.ClientSize = New-Object System.Drawing.Size(510, 360)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.BackColor = [System.Drawing.Color]::FromArgb(18, 18, 18)
$form.ForeColor = [System.Drawing.Color]::White

# ── Label judul ───────────────────────────────────────────────────────────
$lblTitle = New-Object System.Windows.Forms.Label
$lblTitle.Text = "Case Converter"
$lblTitle.Font = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Bold)
$lblTitle.ForeColor = [System.Drawing.Color]::FromArgb(232, 168, 56)
$lblTitle.Location = New-Object System.Drawing.Point(20, 20)
$lblTitle.Size = New-Object System.Drawing.Size(480, 30)
$form.Controls.Add($lblTitle)

$lblSub = New-Object System.Windows.Forms.Label
$lblSub.Text = "Pilih file .docx kasus (tabel) untuk dikonversi jadi case JSON + gambar"
$lblSub.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$lblSub.ForeColor = [System.Drawing.Color]::FromArgb(160, 160, 160)
$lblSub.Location = New-Object System.Drawing.Point(20, 52)
$lblSub.Size = New-Object System.Drawing.Size(480, 20)
$form.Controls.Add($lblSub)

# ── Kotak path file ───────────────────────────────────────────────────────
$lblPath = New-Object System.Windows.Forms.Label
$lblPath.Text = "File .docx"
$lblPath.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$lblPath.ForeColor = [System.Drawing.Color]::FromArgb(200, 200, 200)
$lblPath.Location = New-Object System.Drawing.Point(20, 84)
$lblPath.Size = New-Object System.Drawing.Size(200, 18)
$form.Controls.Add($lblPath)

$txtPath = New-Object System.Windows.Forms.TextBox
$txtPath.Location = New-Object System.Drawing.Point(20, 104)
$txtPath.Size = New-Object System.Drawing.Size(370, 24)
$txtPath.Font = New-Object System.Drawing.Font("Consolas", 9)
$txtPath.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 30)
$txtPath.ForeColor = [System.Drawing.Color]::White
$txtPath.BorderStyle = "FixedSingle"
$form.Controls.Add($txtPath)

$placeholderText = "Path ke file .docx..."
$placeholderColor = [System.Drawing.Color]::FromArgb(120, 120, 120)
$normalColor = [System.Drawing.Color]::White

function Set-Placeholder {
    $txtPath.Text = $placeholderText
    $txtPath.ForeColor = $placeholderColor
}
Set-Placeholder

$txtPath.Add_Enter({
    if ($txtPath.Text -eq $placeholderText) {
        $txtPath.Text = ""
        $txtPath.ForeColor = $normalColor
    }
})
$txtPath.Add_Leave({
    if ([string]::IsNullOrWhiteSpace($txtPath.Text)) {
        Set-Placeholder
    }
})

$btnBrowse = New-Object System.Windows.Forms.Button
$btnBrowse.Text = "Pilih File"
$btnBrowse.Location = New-Object System.Drawing.Point(400, 102)
$btnBrowse.Size = New-Object System.Drawing.Size(90, 28)
$btnBrowse.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$btnBrowse.BackColor = [System.Drawing.Color]::FromArgb(45, 45, 45)
$btnBrowse.ForeColor = [System.Drawing.Color]::White
$btnBrowse.FlatStyle = "Flat"
$btnBrowse.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(80, 80, 80)
$btnBrowse.Cursor = [System.Windows.Forms.Cursors]::Hand
$btnBrowse.Add_Click({
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = "Pilih file .docx kasus"
    $dialog.Filter = "Word Document (*.docx)|*.docx"
    $currentPath = if ($txtPath.Text -ne $placeholderText) { $txtPath.Text } else { "" }
    $dialog.InitialDirectory = if ($currentPath -and (Test-Path (Split-Path $currentPath))) {
        Split-Path $currentPath
    } else {
        [Environment]::GetFolderPath("MyDocuments")
    }
    if ($dialog.ShowDialog() -eq "OK") {
        $txtPath.Text = $dialog.FileName
        $txtPath.ForeColor = $normalColor
    }
})
$form.Controls.Add($btnBrowse)

# ── Kategori (combo box, boleh pilih atau ketik baru) ──────────────────────
$lblKategori = New-Object System.Windows.Forms.Label
$lblKategori.Text = "Kategori (pilih yang sudah ada, atau ketik kategori baru)"
$lblKategori.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$lblKategori.ForeColor = [System.Drawing.Color]::FromArgb(200, 200, 200)
$lblKategori.Location = New-Object System.Drawing.Point(20, 142)
$lblKategori.Size = New-Object System.Drawing.Size(460, 18)
$form.Controls.Add($lblKategori)

$cmbKategori = New-Object System.Windows.Forms.ComboBox
$cmbKategori.Location = New-Object System.Drawing.Point(20, 162)
$cmbKategori.Size = New-Object System.Drawing.Size(200, 24)
$cmbKategori.Font = New-Object System.Drawing.Font("Consolas", 9)
$cmbKategori.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 30)
$cmbKategori.ForeColor = [System.Drawing.Color]::White
$cmbKategori.FlatStyle = "Flat"
$cmbKategori.DropDownStyle = "DropDown"
foreach ($k in $kategoriList) { [void]$cmbKategori.Items.Add($k) }
$form.Controls.Add($cmbKategori)

# ── Kotak log output ──────────────────────────────────────────────────────
$txtLog = New-Object System.Windows.Forms.RichTextBox
$txtLog.Location = New-Object System.Drawing.Point(20, 200)
$txtLog.Size = New-Object System.Drawing.Size(470, 100)
$txtLog.Font = New-Object System.Drawing.Font("Consolas", 8.5)
$txtLog.BackColor = [System.Drawing.Color]::FromArgb(10, 10, 10)
$txtLog.ForeColor = [System.Drawing.Color]::FromArgb(200, 200, 200)
$txtLog.BorderStyle = "FixedSingle"
$txtLog.ReadOnly = $true
$txtLog.ScrollBars = "Vertical"
$txtLog.Text = "Siap. Pilih file .docx, pilih/ketik kategori, lalu klik Konversi."
$form.Controls.Add($txtLog)

function Write-Log {
    param([string]$msg, [string]$color = "normal")
    $txtLog.SelectionStart = $txtLog.TextLength
    $txtLog.SelectionLength = 0
    switch ($color) {
        "ok"      { $txtLog.SelectionColor = [System.Drawing.Color]::FromArgb(134, 239, 172) }
        "error"   { $txtLog.SelectionColor = [System.Drawing.Color]::FromArgb(252, 165, 165) }
        "accent"  { $txtLog.SelectionColor = [System.Drawing.Color]::FromArgb(232, 168, 56)  }
        default   { $txtLog.SelectionColor = [System.Drawing.Color]::FromArgb(200, 200, 200) }
    }
    $txtLog.AppendText("$msg`n")
    $txtLog.ScrollToCaret()
    $form.Refresh()
}

# ── Tombol Konversi ───────────────────────────────────────────────────────
$btnConvert = New-Object System.Windows.Forms.Button
$btnConvert.Text = "▶  Konversi"
$btnConvert.Location = New-Object System.Drawing.Point(20, 310)
$btnConvert.Size = New-Object System.Drawing.Size(150, 36)
$btnConvert.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold)
$btnConvert.BackColor = [System.Drawing.Color]::FromArgb(232, 168, 56)
$btnConvert.ForeColor = [System.Drawing.Color]::FromArgb(10, 10, 10)
$btnConvert.FlatStyle = "Flat"
$btnConvert.FlatAppearance.BorderSize = 0
$btnConvert.Cursor = [System.Windows.Forms.Cursors]::Hand
$btnConvert.Add_Click({
    $docxPath = $txtPath.Text.Trim()
    if ($docxPath -eq $placeholderText) { $docxPath = "" }
    $kategori = $cmbKategori.Text.Trim()

    if (-not $docxPath) {
        Write-Log "⚠  Belum ada file dipilih." "error"
        return
    }
    if (-not (Test-Path $docxPath)) {
        Write-Log "⚠  File tidak ditemukan: $docxPath" "error"
        return
    }
    if ([System.IO.Path]::GetExtension($docxPath).ToLower() -ne ".docx") {
        Write-Log "⚠  Bukan file .docx." "error"
        return
    }
    if (-not $kategori) {
        Write-Log "⚠  Kategori belum diisi." "error"
        return
    }

    $btnConvert.Enabled = $false
    $btnBrowse.Enabled = $false
    $txtLog.Clear()

    # npm install (hanya kalau node_modules belum ada)
    $nodeModules = Join-Path $projectRoot "node_modules"
    if (-not (Test-Path $nodeModules)) {
        Write-Log "[ npm install ] (pertama kali saja)" "accent"
        $installProc = Start-Process -FilePath "cmd.exe" `
            -ArgumentList "/c npm install 2>&1" `
            -WorkingDirectory $projectRoot `
            -RedirectStandardOutput "$env:TEMP\caseconv_install.txt" `
            -RedirectStandardError  "$env:TEMP\caseconv_install_err.txt" `
            -NoNewWindow -Wait -PassThru

        $installOut = if (Test-Path "$env:TEMP\caseconv_install.txt") { Get-Content "$env:TEMP\caseconv_install.txt" -Raw } else { "" }
        if ($installOut.Trim()) { Write-Log $installOut.Trim() }

        if ($installProc.ExitCode -ne 0) {
            $errOut = if (Test-Path "$env:TEMP\caseconv_install_err.txt") { Get-Content "$env:TEMP\caseconv_install_err.txt" -Raw } else { "" }
            Write-Log "npm install gagal (exit $($installProc.ExitCode))." "error"
            if ($errOut.Trim()) { Write-Log $errOut.Trim() "error" }
            $btnConvert.Enabled = $true
            $btnBrowse.Enabled = $true
            return
        }
        Write-Log "npm install selesai." "ok"
    }

    # jalankan converter
    Write-Log "[ node scripts/docx-to-case.js ... --kategori $kategori ]" "accent"
    $convertProc = Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/c node `"$converterJs`" `"$docxPath`" --kategori `"$kategori`" 2>&1" `
        -WorkingDirectory $projectRoot `
        -RedirectStandardOutput "$env:TEMP\caseconv_convert.txt" `
        -RedirectStandardError  "$env:TEMP\caseconv_convert_err.txt" `
        -NoNewWindow -Wait -PassThru

    $convertOut = if (Test-Path "$env:TEMP\caseconv_convert.txt") { Get-Content "$env:TEMP\caseconv_convert.txt" -Raw } else { "" }
    $convertErr = if (Test-Path "$env:TEMP\caseconv_convert_err.txt") { Get-Content "$env:TEMP\caseconv_convert_err.txt" -Raw } else { "" }

    if ($convertOut.Trim()) { Write-Log $convertOut.Trim() }
    if ($convertErr.Trim()) { Write-Log $convertErr.Trim() "error" }

    if ($convertProc.ExitCode -eq 0) {
        Write-Log "✓  Konversi selesai. Cek data/cases/$kategori/ untuk hasilnya." "ok"
    } else {
        Write-Log "✗  Konversi gagal (exit $($convertProc.ExitCode))." "error"
    }

    $btnConvert.Enabled = $true
    $btnBrowse.Enabled = $true
})
$form.Controls.Add($btnConvert)

# ── Run ───────────────────────────────────────────────────────────────────
$form.Add_Shown({ $form.Activate() })
[System.Windows.Forms.Application]::Run($form)
