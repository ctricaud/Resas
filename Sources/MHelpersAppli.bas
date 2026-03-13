Attribute VB_Name = "MHelpersAppli"

Public dicListings As Object
Public dicOwners As Object
Public dicPlatform As Object
Public idxResas As Object
Public Sub RAZFiltres_ListeRésas()
    '+++++++++++++++++++++++++++++++++++++++++++++++
    '+ On efface tous les filtres
    '+++++++++++++++++++++++++++++++++++++++++++++++
    With Feuil5.Range("ListeRésas").ListObject
        If Not .AutoFilter Is Nothing _
           Then .AutoFilter.ShowAllData
    End With
    
 TriListeResas
    
    'On met à jour le texte du bouton de sélection du mois
    'FiltreMois.Caption = "Mois en cours"
    'MoisFiltre = 0
End Sub
Sub LectureDicListings()
'
'Cette procédure permet de récupérer dans un dictionnaire tous les logements exictants
'
'If Not idxResas Is Nothing Then Exit Sub

Set dicListings = New Dictionary

If Not Feuil3.Range("TListings").ListObject.DataBodyRange Is Nothing Then
    Dim T As Variant
    T = Feuil3.Range("TListings").ListObject.DataBodyRange.Value
    
    Dim i As Long
    For i = 1 To UBound(T)
        dicListings(T(i, 2)) = i
    Next i
End If

Set dicOwners = New Dictionary

If Not Feuil4.Range("TOwners").ListObject.DataBodyRange Is Nothing Then
    T = Feuil4.Range("TOwners").ListObject.DataBodyRange.Value
    
    For i = 1 To UBound(T)
        dicOwners(T(i, 1)) = T(i, 2)
    Next i
End If

CalculIdxResas
End Sub

Function ISO8601ToDate(isoDate) As Date
    Dim dt As String
    Dim D As Date
    
    ' Retire le Z s'il existe
    If Right(isoDate, 1) = "Z" Then
        isoDate = Left(isoDate, Len(isoDate) - 1)
    End If
    
    ' Remplace le T par un espace
    dt = Replace(isoDate, "T", " ")
    
    ' Retire la partie millisecondes si elle existe
    If InStr(dt, ".") > 0 Then
        dt = Left(dt, InStr(dt, ".") - 1)
    End If
    
    ' Conversion en date
    On Error Resume Next
    D = CDate(dt)
    On Error GoTo 0
    
    ISO8601ToDate = D
End Function




Sub CalculIdxResas()
'---------------------------------------------------------
'Mise à jour des cononnes ed listeRésas
'---------------------------------------------------------
    Dim i As Integer
    
    Set idxResas = New Dictionary
    For i = 1 To Range("ListeRésas").ListObject.ListColumns.Count
        idxResas(Range("ListeRésas").ListObject.ListColumns(i).Name) = i
    Next i
    
End Sub
Sub TriListeResas()
    If Feuil5.Range("ListeRésas").ListObject.DataBodyRange Is Nothing Then Exit Sub
    
    RAZFiltres "ListeRésas"
    With Feuil5.Range("ListeRésas").ListObject
        .ListColumns("Date Debut").DataBodyRange.NumberFormat = "dd/mm/yyyy"
   
        '--- Trier par DateDébut en ordre décroissant
    
        .Sort.SortFields.Clear
        .Sort.SortFields.Add key:=.ListColumns("Date Debut").Range, _
            SortOn:=xlSortOnValues, Order:=xlDescending, DataOption:=xlSortNormal
        With .Sort
            .header = xlYes
            .Apply
        End With
    End With
    
    '--- Supprimer tous les critères de tri
    Range("ListeRésas").ListObject.Sort.SortFields.Clear
End Sub

Function URLEncode(ByVal sText As String) As String
    Dim i As Long, sRes As String, sChar As String
    For i = 1 To Len(sText)
        sChar = Mid$(sText, i, 1)
        Select Case Asc(sChar)
            Case 48 To 57, 65 To 90, 97 To 122
                sRes = sRes & sChar
            Case Else
                sRes = sRes & "%" & Hex(Asc(sChar))
        End Select
    Next i
    URLEncode = sRes
End Function


