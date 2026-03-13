Attribute VB_Name = "MHelpers"
Sub RAZFiltres(Tableau As String)
    With Range(Tableau).ListObject
        If Not .AutoFilter Is Nothing Then .AutoFilter.ShowAllData
        .ShowAutoFilter = True
    End With
End Sub
Sub RAZTableau(Tableau As String, Optional nbLignes = 0)
  
    If Not Range(Tableau).ListObject.DataBodyRange Is Nothing Then
        Range(Tableau).ListObject.DataBodyRange.Delete
    End If
    
    If nbLignes > 0 Then
        Dim tListObject As ListObject
        Set tListObject = Range(Tableau).ListObject
        tListObject.Resize tListObject.Range.Resize(nbLignes + 1)
    End If
End Sub
Sub EcritureTexte(ByVal TexteAEnregistrer As String, ByVal FichierChemin As String)
    
    Dim FichierNum As Integer
    
    ' Obtient un numéro de fichier libre
    FichierNum = FreeFile
    
    On Error GoTo ErreurGestion
    
    ' Ouvre le fichier en mode Output (crée le fichier, écrase s'il existe)
    Open FichierChemin For Output As #FichierNum
    
    ' Écrit le contenu de la variable dans le fichier
    Print #FichierNum, TexteAEnregistrer
    
    ' Ferme le fichier
    Close #FichierNum
    Exit Sub
    
ErreurGestion:
    ' Gestion des erreurs (ex: chemin invalide, droits insuffisants)
    If FichierNum <> 0 Then Close #FichierNum
    MsgBox "Erreur " & Err.Number & " lors de l'écriture du fichier : " & Err.Description, vbCritical
    
End Sub






