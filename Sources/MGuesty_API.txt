Attribute VB_Name = "MGuesty_API"

Option Explicit

'---- Constants

Private Const GUESTY_TOKEN_URL As String = "https://open-api.guesty.com/oauth2/token"

Private Const GUESTY_OWNERS_URL = "https://open-api.guesty.com/v1/owners?fields=fullName"

Private Const GUESTY_LISTINGS_URL = "https://open-api.guesty.com/v1/listings?active=true&limit=100&skip=0&fields=_id"
Private Const GUESTY_LISTING_DETAILS_URL = "https://open-api.guesty.com/v1/listings/"

Private Const GUESTY_RESERVATIONS_URL As String = "https://open-api.guesty.com/v1/reservations?" _
            & "fields=money.payments.status%20money.payments.paidAt%20money.payments.amount%20status%20checkIn%20checkOut%20lastUpdatedAt%20createdAt%20nightsCount%20confirmationCode&" _
            & "sort=-checkIn&limit=100"
Private Const GUESTY_REVIEWS_URL As String = "https://open-api.guesty.com/v1/reviews?limit=100"
Private Const GUESTY_PRICES_URL As String = "https://open-api.guesty.com/v1/availability-pricing/api/calendar/listings"
Private Const GUESTY_RESERVATION_DETAIL As String = "https://open-api.guesty.com/v1/reservations/"

'-------------------------Les variables
Public dicSource, dicLogement As Object
 
Sub GuestyGetListing(idListing As String)
    '----------------------------------------------------------------------------
    'Permet de récupérer toutes les informations concernant un listing
    '----------------------------------------------------------------------------
     '----------------------------------------------------------------------------
    '1. On récupère les informations sur la réservation
    '----------------------------------------------------------------------------
    Dim token As String
    token = GetGuestyToken()
    If dicListings.Count = 0 Then LectureDicListings
    
    Dim url As String
    url = GUESTY_LISTING_DETAILS_URL & idListing

    Dim http As Object ' WinHttp.WinHttpRequest.5.1
    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.Open "GET", url, False
    http.SetRequestHeader "accept", "application/json"
    http.SetRequestHeader "Authorization", "Bearer " & token
    http.Send

    If http.Status < 200 Or http.Status >= 300 Then
        Err.Raise vbObjectError + 911, , "HTTP " & http.Status & " - " & http.responsetext
    End If

   '---------------------------------------------------------------------------------
    '3. On récupère les informations qui nous intéressent
   '---------------------------------------------------------------------------------
   Dim dic As Object
    Set dic = ParseJson(http.responsetext)
     
    Dim T(1 To 12)
    Dim ownerId
    Dim texte As String
    Dim p As Long, q As Long
    
    texte = """owners"":["""
    p = InStr(http.responsetext, texte) + Len(texte)
    q = InStr(p, http.responsetext, Chr(34))
    ownerId = Mid(http.responsetext, p, q - p)
    
    T(1) = dic(".businessModel.name")
    T(2) = idListing
    T(3) = dicOwners(ownerId)
    T(4) = dic(".title")
    T(5) = dic(".commissionTaxPercentage")
    T(6) = dic(".active")
    T(7) = CCur(dic(".financials.cleaningFee.value.formula"))
    T(8) = dic(".netIncomeFormula")
    T(9) = dic(".commissionFormula")
    T(10) = dic(".ownerRevenueFormula")
    T(11) = dic(".integrations(0).externalUrl")
    T(12) = dic(".type")
    
    'Calcul de la commission
    If T(5) <> "" Then
        'On retrouve la commission
        texte = "net_income*"
        p = InStr(T(9), texte) + Len(texte)
        q = InStr(p, T(9), " ")
        If q = 0 Then q = Len(T(9)) + 1
        
        T(5) = CDbl(Replace(Mid(T(9), p, q - p), ".", ",")) * (100 + T(5)) / 100
    End If
    
    'On créée des noms de logement
    If T(1) = "" Then
            T(1) = T(3) + " - " + Right(T(2), 2)
        
    End If
    
    Dim newRow As ListRow
    Set newRow = ThisWorkbook.Sheets("Listings").ListObjects("Tlistings").ListRows.Add(AlwaysInsert:=True)
    newRow.Range.Cells(1, 1).Resize(1, UBound(T)).Value = T
    
End Sub


 Sub GuestyGetOwners()
 
 
    '----------------------------------------------------------------------------
    'Permet de récupérer tous les propriétaires suivis
    '----------------------------------------------------------------------------
     '----------------------------------------------------------------------------
    '1. On récupère les informations sur la réservation
    '----------------------------------------------------------------------------
    Dim token As String
    token = GetGuestyToken()
    
    Dim url As String
    url = GUESTY_OWNERS_URL

    Dim http As Object ' WinHttp.WinHttpRequest.5.1
    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.Open "GET", url, False
    http.SetRequestHeader "Accept", "application/json"
    http.SetRequestHeader "Authorization", "Bearer " & token
    http.Send

    If http.Status < 200 Or http.Status >= 300 Then
        Err.Raise vbObjectError + 911, , "HTTP " & http.Status & " - " & http.responsetext
    End If
   
   '---------------------------------------------------------------------------------
    '2. On créée la table des propriétaires
   '---------------------------------------------------------------------------------
    Dim dic As Object
    Dim key As Variant
    Dim i As Long
    Set dic = ParseJson(http.responsetext)
    
    Dim T(1 To 300, 1 To 2)
    Dim nbOwners As Long
    
    For i = 0 To 300
        'On vérifie si nous ne sommes pas arrivés au bout
        If dic("(" & i & ")._id") = "" Then Exit For
        
        nbOwners = nbOwners + 1
        T(nbOwners, 1) = dic("(" & i & ")._id")
        T(nbOwners, 2) = dic("(" & i & ").fullName")
    Next i
    
    'On met à jour le tableau
    TableToTableau T, "TOwners", nbOwners
    Debug.Print nbOwners & " Propriétaires trouvés"
 End Sub


Sub GuestyAddReservation(idReservation As Variant)
    '------------------------------------------------------------------
    'Ajoute la réservatio à listeRésas
    '--------------
    Dim dicResa As Object
    Set dicResa = GuestyGetReservation(idReservation)
    
    'On crée la table qui contient les éléments à insérer
    Dim T(1 To 26)
    
    'On insère les informations
    Dim key
    For Each key In dicResa
        If idxResas(key) <> "" Then
            T(idxResas(key)) = dicResa(key)
        End If
    Next key
    
    '------------------------------------------------------------------
    '2. Mise à jour des champs
    '------------------------------------------------------------------
    Dim L As Variant, comm
    L = Feuil3.Range("Tlistings").Value
    comm = CCur(L(dicListings(T(idxResas("Listing"))), 5))
    T(idxResas("Listing")) = L(dicListings(T(idxResas("Listing"))), 1)
 
    T(idxResas("Versement")) = CCur((T(idxResas("Prix")) - T(idxResas("Menage")) - T(idxResas("Commission"))) * (1 - comm))
    T(idxResas("HOBE")) = CCur(T(idxResas("Menage")) + T(idxResas("Versement")) * comm / (1 - comm))
    T(idxResas("Nuits")) = CCur(T(idxResas("Prix")) / T(idxResas("Duree")))
    
     T(idxResas("Date Debut")) = Int(T(idxResas("Date Debut")))
    T(idxResas("BookingDate")) = Int(T(idxResas("BookingDate")))
    
    '------------------------------------------------------------------
    '3. On insère la réservation
    '------------------------------------------------------------------
    Feuil5.Range("ListeRésas").ListObject.ListRows.Add 1
    Feuil5.Range("ListeRésas").ListObject.ListRows(1).Range.Value = T
    
    

    '------------------------------------------------------------------
    '2. On met à jour les logs
    '------------------------------------------------------------------
    Dim texte As String
    
    texte = "Nouvelle réservation " + T(2) + " :" + Chr(10) _
        & T(1) & " arrivée le " & Format(T(3), "dd/mm/yyyy") & " pour " + T(4) + " nuits." & Chr(10) _
        & "Versement : " & T(10) & " €"
    log texte
    log "---------"
        
End Sub




Public Function GuestyGetReservation(ByVal reservationId As String) As Object
    '----------------------------------------------------------------------------
    'Permet de récupérer toutes les informations concernant les résas
    '----------------------------------------------------------------------------
     '----------------------------------------------------------------------------
    '1. On récupère les informations sur la réservation
    '----------------------------------------------------------------------------
    Dim token As String
    token = GetGuestyToken()
    
    Dim url As String
    url = GUESTY_RESERVATION_DETAIL & reservationId '& "?fields=money.hostPayout%20guestStay.createdAt" _
        & "%20guest.phone%20guest.fullName%20numberOfGuests.numberOfAdults%20numberOfGuests.numberOfChildren%20numberOfGuests.numberOfInfants%20numberOfGuests.numberOfPets" _
        & "%20money.payments.fees.amount" _
        & "%20money.fareAccommodationAdjusted%20nightsCount%20checkIn%20money.fareCleaning%20money.hostServiceFee%20money.totalTaxes%20money.totalPaid"


    Dim http As Object ' WinHttp.WinHttpRequest.5.1
    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    http.Open "GET", url, False
    http.SetRequestHeader "Accept", "application/json"
    http.SetRequestHeader "Authorization", "Bearer " & token
    http.Send

    If http.Status < 200 Or http.Status >= 300 Then
        Err.Raise vbObjectError + 911, , "HTTP " & http.Status & " - " & http.responsetext
    End If


    '---------------------------------------------------------------------------------
   '2. On créée les dictionnaires dont on a besoin
   '---------------------------------------------------------------------------------
   LectureDicListings
   
   '---------------------------------------------------------------------------------
    '3. On récupère les informations qui nous intéressent
   '---------------------------------------------------------------------------------
    Dim dic, ret As Object
    Set dic = ParseJson(http.responsetext)
    EcritureTexte http.responsetext, "c:\temp\sortie.txt"
    Dim dicRet As Object
    Set dicRet = New Dictionary
    Dim Fees As Currency
    
    dicRet("BookingDate") = ISO8601ToDate(dic(".guestStay.createdAt"))
    dicRet("Numero") = reservationId
    dicRet("statut") = dic(".status")
   dicRet("Listing") = dic(".listingId")
    dicRet("Platform") = dic(".integration.platform")
    dicRet("Duree") = dic(".nightsCount")
    dicRet("Solde") = dic(".money.balanceDue")
    dicRet("fullyPaid") = dic(".money.isFullyPaid")
    dicRet("Date Debut") = ISO8601ToDate(dic(".checkIn"))
    dicRet("checkOut") = ISO8601ToDate(dic(".checkOut"))
     dicRet("PrixOriginal") = dic(".money.fareAccommodation")
    
    
    'Ménage
    dicRet("Menage") = CCur(Replace(dic(".money.fareCleaning"), ".", ","))
    
    'Prix total hors taxe de séjour
    dicRet("Prix") = CCur(Replace(dic(".money.netIncome"), ".", ",")) + CCur(dicRet("Menage"))
    
    'ownerRevenue
    dicRet("OwnerRevenue") = CCur(Replace(dic(".money.ownerRevenue"), ".", ","))
    
    'Versement
    
    'Hobe
    
    'Commission
    dicRet("Commission") = dicRet("Prix") - CCur(Replace(dic(".money.ownerRevenue"), ".", ","))
     
     If dic(".money.payments(0).fees(0).amount") <> "" Then
        Fees = CCur(Replace(dic(".money.payments(0).fees(0).amount"), ".", ","))
    Else
        Fees = 0
    End If
    dicRet("Commission") = dicRet("Commission") + Fees
   
     
    Set GuestyGetReservation = dicRet

End Function
Sub GuestyGetListings()

    ' 1. Déclarer les variables
    Dim objHTTP As Object
    Dim UrlGuesty As String
    Dim AuthToken As String
    Dim ApiResponse As String
    
    ' 2. Définir l'URL et le Token
    UrlGuesty = GUESTY_LISTINGS_URL
    
    ' ATTENTION : Saisissez ICI le token complet (la longue chaîne que vous avez fournie)
    AuthToken = GetGuestyToken
    
    ' 3. Créer l'objet de requête (Late Binding)
    Set objHTTP = CreateObject("WinHttp.WinHttpRequest.5.1")
    
    ' 4. Ouvrir la requête GET
    objHTTP.Open "GET", UrlGuesty, False ' False = Synchrone
    
    ' 5. Configurer les En-têtes (Headers)
    
    ' L'en-tête d'autorisation (CRUCIAL : 'Bearer ' suivi d'un espace, puis du token)
    objHTTP.SetRequestHeader "Authorization", "Bearer " & AuthToken
    
    ' L'en-tête de contenu (Bonne pratique pour les API REST)
    objHTTP.SetRequestHeader "Content-Type", "application/json"
    
    ' L'en-tête d'acceptation (Pour s'assurer que la réponse est en JSON)
    objHTTP.SetRequestHeader "Accept", "application/json"
    
    ' 6. Envoyer la requête
    objHTTP.Send
    
    ' 7. Traiter la réponse
    
    If objHTTP.Status = 200 Then
        ' La requête a réussi (HTTP 200 OK)
        ApiResponse = objHTTP.responsetext
        
          '********* Prochaine étape : Parser le JSON ici *********
        Dim dic As Object
        Set dic = ParseJson(ApiResponse)
        
        Dim nbListings As Long
        nbListings = dic(".count")
        
        LectureDicListings
        
        Dim i As Long
        Dim idListing As String
        
        For i = 0 To nbListings - 1
            idListing = dic(".results(" & i & ")._id")
                If dicListings(idListing) = "" Then
                    'On retrouve les informations du listing
                    GuestyGetListing idListing
                End If
        Next i
      
        
        
        
    ElseIf objHTTP.Status = 401 Or objHTTP.Status = 403 Then
        ' Échec d'autorisation (HTTP 401 Unauthorized ou 403 Forbidden)
        MsgBox "Erreur d'authentification Guesty. Statut HTTP : " & objHTTP.Status & vbCrLf & _
               "Vérifiez que votre token est correct et non expiré. Message : " & objHTTP.responsetext, vbCritical
               
    Else
        ' Autres erreurs (ex: 400 Bad Request, 500 Server Error)
        MsgBox "Erreur de requête Guesty. Statut HTTP : " & objHTTP.Status & vbCrLf & _
               "Message d'erreur : " & objHTTP.responsetext, vbCritical
    End If
    
    ' Nettoyage
    Set objHTTP = Nothing

End Sub
Function GetGuestyToken() As String
    ' Déclaration explicite des variables
    Dim http As Object
    Dim dic As Object
    Dim url As String, postData As String, responseBody As String
    Dim cacheDate As Variant
    
    ' --- 1. GESTION D'ERREUR ---
    On Error GoTo ErrHandler
    
    ' --- 2. VÉRIFICATION DU CACHE (Sécurisée) ---
    ' On utilise un Variant pour cacheDate pour éviter l'erreur "Type Mismatch" si la cellule est vide
    cacheDate = Feuil2.Range("dateToken").Value
    
    If IsDate(cacheDate) Then
        If Now < CDate(cacheDate) Then
            ' Le token est encore valide, on le retourne directement
            GetGuestyToken = Feuil2.Range("lastToken").Value
            Exit Function
        End If
    End If
    
    ' --- 3. PRÉPARATION DE LA REQUÊTE ---
    url = GUESTY_TOKEN_URL
    
    postData = "grant_type=client_credentials" & _
               "&scope=open-api" & _
               "&client_id=" & URLEncode(GUESTY_CLIENT_ID) & _
               "&client_secret=" & URLEncode(GUESTY_CLIENT_SECRET)
    
    Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
    
    ' TIMEOUTS (Important !) : Resolve, Connect, Send, Receive (en ms)
    ' Ici : 5s pour connecter, 10s pour recevoir. Évite le gel d'Excel.
    http.setTimeouts 5000, 5000, 10000, 10000
    
    http.Open "POST", url, False
    http.SetRequestHeader "Accept", "application/json"
    http.SetRequestHeader "Content-Type", "application/x-www-form-urlencoded"
    
    ' --- 4. ENVOI ET CONTRÔLE DE RÉCEPTION ---
    http.Send postData
    
    ' Vérification du statut HTTP (200 = OK)
    If http.Status <> 200 Then
        Err.Raise vbObjectError + 1, "GetGuestyToken", _
        "Erreur API (" & http.Status & "): " & http.responsetext
    End If
    
    responseBody = http.responsetext
    
    ' --- 5. PARSING ET STOCKAGE ---
    Set dic = ParseJson(responseBody)
    
    ' Note : Vérifiez bien la structure de votre JSON.
    ' Standard OAuth2 : dic("access_token") et dic("expires_in")
    ' Si votre ParseJson retourne une structure à plat, gardez votre syntaxe précédente.
    
    If dic Is Nothing Then Err.Raise vbObjectError + 2, "GetGuestyToken", "Erreur de parsing JSON"
    
    ' On vérifie que la clé existe avant de l'utiliser
    If Not dic.Exists(".access_token") Then
              Err.Raise vbObjectError + 3, "GetGuestyToken", "Token introuvable dans la réponse JSON"
    Else
        ' Cas Standard
        Feuil2.Range("lastToken").Value = dic(".access_token")
        ' On retire 60 secondes à la date d'expiration pour avoir une marge de sécurité
        Feuil2.Range("dateToken").Value = DateAdd("s", CLng(dic(".expires_in")) - 60, Now)
    End If
    
    GetGuestyToken = Range("lastToken").Value
    
    ' Nettoyage mémoire
    Set http = Nothing
    Set dic = Nothing
    Exit Function

ErrHandler:
    ' En cas d'erreur, on affiche le problème dans la fenêtre Exécution et on retourne une chaine vide
    Debug.Print "ERREUR GetGuestyToken: " & Err.Description
    ' Optionnel : MsgBox "Impossible de récupérer le token Guesty : " & Err.Description, vbCritical
    GetGuestyToken = ""
    Set http = Nothing
    Set dic = Nothing
End Function
Public Sub GuestyGetReservations(Optional effaceLog = True)
    'Récupération des cent dernières réservations
    If effaceLog Then Feuil1.Range("log") = ""
   '--------------------------------------------------------------------------
    ' 1) Token (ta fonction existante)
    '--------------------------------------------------------------------------
   Dim token As String
    token = GetGuestyToken()
    
    LectureDicListings
    Dim listings As Variant
    listings = Feuil3.Range("Tlistings").Value
    '--------------------------------------------------------------------------
   ' 2) Appel API (100 dernières, tri décroissant)
    '--------------------------------------------------------------------------
   Dim url As String
    Dim i As Long, filterJson As String
    Dim filterEncoded As String
    
   

    ' [{"operator":"$in","field":"listingId"},]
    'filterJson = "[{""operator"":""$in"",""field"":""listingId"",""value"":[" & values & "]},]"
filterJson = "[ " & _
             "{""operator"":""$in"",""field"":""status"",""value"":[""confirmed""]}]"
    '--- Encodage URL du JSON ---
    filterEncoded = URLEncode(filterJson)
    
    '--- Requête ---
    token = GetGuestyToken()
    
    Dim Boucle As Integer
    Dim T As Variant
    Dim nbReservations As Long
    ReDim T(1 To 2000, 1 To 18)
    
    For Boucle = 1 To 5
        url = GUESTY_RESERVATIONS_URL & "&filters=" & filterEncoded & "&limit=100&skip=" & CStr(Boucle * 100 - 100)
    
        Dim http As Object ' WinHttp.WinHttpRequest.5.1
        Set http = CreateObject("WinHttp.WinHttpRequest.5.1")
        http.Open "GET", url, False
        http.setTimeouts 15000, 15000, 30000, 30000
        http.SetRequestHeader "Accept", "application/json"
        http.SetRequestHeader "Authorization", "Bearer " & token
        http.Send
    
        If http.Status < 200 Or http.Status >= 300 Then
            Err.Raise vbObjectError + 701, , "HTTP " & http.Status & " - " & http.responsetext
        End If
    
        '--------------------------------------------------------------------------
       ' 3) Réponse JSON
       '--------------------------------------------------------------------------
        Dim resp As String
        resp = http.responsetext
        Dim dir As Object
        Set dir = ParseJson(resp)
        
        '--------------------------------------------------------------------------
       ' 4) Mis en table du retour
       '--------------------------------------------------------------------------
       
        
        For i = 0 To 99
            T(nbReservations + 1, idxResas("Platform")) = dir(".results(" & CStr(i) & ").integration.platform")
           
            'T(nbReservations + 1, idxResas("Statut")) = dir(".results(" & CStr(i) & ").status")
            T(nbReservations + 1, idxResas("Numero")) = dir(".results(" & CStr(i) & ")._id")
            T(nbReservations + 1, idxResas("Date Debut")) = ISO8601ToDate(dir(".results(" & CStr(i) & ").checkIn"))
            T(nbReservations + 1, idxResas("Duree")) = dir(".results(" & CStr(i) & ").nightsCount")
            If dicListings(dir(".results(" & CStr(i) & ").listingId")) = "" Then
                If dir(".results(" & CStr(i) & ").listingId") = "" Then
                    Exit For
                Else
                    Stop
                End If
            End If
            T(nbReservations + 1, idxResas("Listing")) = listings(dicListings(dir(".results(" & CStr(i) & ").listingId")), 1)
             
            If nbReservations > 0 Then
                'If T(nbReservations + 1, 1) = T(nbReservations, 1) And T(nbReservations + 1, 3) = T(nbReservations, 3) Then Stop
                'EcritureTexte http.responsetext, "c:\temp\sortie.txt"
           End If
            nbReservations = nbReservations + 1
            
        Next i
    Next Boucle
    '--------------------------------------------------------------------------
   ' 5) On met à jour le tableau structuré ListeGuesty
   '--------------------------------------------------------------------------
   TableToTableau T, "ListeGuesty", nbReservations
   
   Feuil6.Range("ListeGuesty").ListObject.ListColumns(idxResas("Date Debut")).DataBodyRange.NumberFormat = "m/d/yyyy"
   
    '--- Trier par DateDébut en ordre décroissant
        With Feuil6.Range("ListeGuestY").ListObject
        .Sort.SortFields.Clear
        .Sort.SortFields.Add key:=.ListColumns("Date Debut").Range, _
            SortOn:=xlSortOnValues, Order:=xlDescending, DataOption:=xlSortNormal
        With .Sort
            .header = xlYes
            .Apply
        End With
    End With

    '--- Supprimer tous les critères de tri
    Feuil6.Range("ListeGuestY").ListObject.Sort.SortFields.Clear

     
    '--------------------------------------------------------------------------
   ' 6) On traite le tableau
   '--------------------------------------------------------------------------
   GuestyTraitementReservations
   
  
End Sub

Sub GuestyRemoveReservation(iReservation)
    '-------------------------------------------------------------------
    'On supprime la réservation qui n'a pas été trouvée dans Guesty
    '-------------------------------------------------------------------
    '1. On met le message
    '-------------------------------------------------------------------
    Dim T As Variant
    T = Range("ListeRésas").rows(iReservation)

    Dim texte As String
    
    texte = "Annulation réservation " + T(1, 2) + " :" + Chr(10) _
        & T(1, 1) & " arrivée le " & Format(T(1, 3), "dd/mm/yyyy") & " pour " + CStr(T(1, 4)) + " nuits." & Chr(10) _
        & "Versement : " & CStr(T(1, 10)) & " €"
    log texte
    log ""
    
    '-------------------------------------------------------------------
    '2. On supprime la ligne
    '-------------------------------------------------------------------
    Range("ListeRésas").ListObject.ListRows(iReservation).Delete
    
End Sub

Sub GuestyTraitementReservations()
'--------------------------------------------------------------------------
   ' Cette procédure permet de traiter les réservations chargées
   '--------------------------------------------------------------------------
    '1. On initialise listeRésa pour enlever les filtres et trier suivant la date de début
   '--------------------------------------------------------------------------
    LectureDicListings
    TriListeResas
    
    '--------------------------------------------------------------------------
    '2. On recherche Guesty dans Listerésas
   '--------------------------------------------------------------------------
    CompareResasDansGuesty
    
    '--------------------------------------------------------------------------
    '3. On cherche ListeRésas dans listeGuesty
   '--------------------------------------------------------------------------
    CompareGuestyDansResas
    
    TriListeResas
End Sub
'--- Clé composite stable : logement|source|yyyymmdd|nbNuits
Private Function KeyOf(Logement As Variant, Source As Variant, D As Variant, nbNuits As Variant) As String
    KeyOf = CStr(Logement) & "|" & CStr(Source) & "|" & Format(CDate(D), "yyyymmdd") & "|" & CStr(nbNuits)
End Function

Sub CompareResasDansGuesty()
    '--------------------------------------------------------------------------------
    'Permet de comparer les listes issues de Guesty et de ListeRésas
    '--------------------------------------------------------------------------------
    '1. On construit le dictionnaire des réservations existantes
    '--------------------------------------------------------------------------------
    Dim loR As ListObject, log As ListObject
    Dim D As Object, r As Long, nr As Long, nG As Long
    Dim k As String, out(), col As ListColumn
    
    Set loR = Feuil5.Range("ListeRésas").ListObject
    Set log = Feuil6.Range("ListeGuesty").ListObject
    
    '--- Construire l'index des réservations existantes (ListeRésas)
    Set D = CreateObject("Scripting.Dictionary")
    D.CompareMode = vbTextCompare
    If Not loR.DataBodyRange Is Nothing Then nr = loR.DataBodyRange.rows.Count
    If nr > 0 Then
        Dim aLogR, aSrcR, aDateR, aNuitR
        aLogR = loR.ListColumns("Listing").DataBodyRange.Value
        aSrcR = loR.ListColumns("Platform").DataBodyRange.Value
        aDateR = loR.ListColumns("Date Debut").DataBodyRange.Value
        aNuitR = loR.ListColumns("Duree").DataBodyRange.Value
        
        For r = 1 To nr
            k = KeyOf(aLogR(r, 1), aSrcR(r, 1), aDateR(r, 1), aNuitR(r, 1))
            D(k) = r
        Next r
    End If
    
    '--------------------------------------------------------------------------------
    '2. On vérifie l'existence des réservations de listeGuesty
    '--------------------------------------------------------------------------------
    '--- Vérifier chaque résa de ListeGuesty contre l'index
    nG = log.DataBodyRange.rows.Count
    If nG = 0 Then Exit Sub
    
    Dim gLog, gSrc, gDate, gNuit, gidReservation
    gLog = log.ListColumns("Listing").DataBodyRange.Value
    gSrc = log.ListColumns("Platform").DataBodyRange.Value
    gDate = log.ListColumns("Date Debut").DataBodyRange.Value
    gNuit = log.ListColumns("Duree").DataBodyRange.Value
    gidReservation = log.ListColumns(idxResas("Numero")).DataBodyRange.Value
    
    ReDim out(1 To nG, 1 To 1)
    For r = 1 To nG
        k = KeyOf(gLog(r, 1), gSrc(r, 1), gDate(r, 1), gNuit(r, 1))
        If Not (D.Exists(k)) Then
            GuestyAddReservation gidReservation(r, 1)
        End If
            
    Next r
    
End Sub

Sub CompareGuestyDansResas()
    '--------------------------------------------------------------------------------
    'Permet de comparer les listes issues de Guesty et de ListeRésas
    '--------------------------------------------------------------------------------
    '1. On construit le dictionnaire des réservations existantes
    '--------------------------------------------------------------------------------
    Dim loR As ListObject, log As ListObject
    Dim D As Object, r As Long, nr As Long, nG As Long
    Dim k As String, out(), col As ListColumn
    
    LectureDicListings
    
    
    Set loR = Feuil6.Range("ListeGuesty").ListObject
    Set log = Feuil5.Range("ListeRésas").ListObject
    
    '--- Construire l'index des réservations existantes (ListeRésas)
    Set D = CreateObject("Scripting.Dictionary")
    D.CompareMode = vbTextCompare
    
    nr = loR.DataBodyRange.rows.Count
    If nr > 0 Then
        Dim aLogR, aSrcR, aDateR, aNuitR
        aLogR = loR.ListColumns("Listing").DataBodyRange.Value
        aSrcR = loR.ListColumns("Platform").DataBodyRange.Value
        aDateR = loR.ListColumns("Date Debut").DataBodyRange.Value
        aNuitR = loR.ListColumns("Duree").DataBodyRange.Value
        
        For r = 1 To nr
            k = KeyOf(aLogR(r, 1), aSrcR(r, 1), aDateR(r, 1), aNuitR(r, 1))
            D(k) = r
        Next r
    End If
    
    '--------------------------------------------------------------------------------
    '2. On vérifie l'existence des réservations de listeRésas
    '--------------------------------------------------------------------------------
    '--- Vérifier chaque résa de ListeRésas contre l'index
    nG = log.DataBodyRange.rows.Count
    If nG = 0 Then Exit Sub
    
    Dim gLog, gSrc, gDate, gNuit, gidReservation
    gLog = log.ListColumns("Listing").DataBodyRange.Value
    gSrc = log.ListColumns("Platform").DataBodyRange.Value
    gDate = log.ListColumns("Date Debut").DataBodyRange.Value
    gNuit = log.ListColumns("Duree").DataBodyRange.Value
    gidReservation = log.ListColumns(idxResas("Numero")).DataBodyRange.Value
    

    For r = 1 To nG
        k = KeyOf(gLog(r, 1), gSrc(r, 1), gDate(r, 1), gNuit(r, 1))
        If CLng(Now) - CLng(gDate(r, 1)) > 20 Then Exit For ' c 'est trop vieux et sans intérêt
        If Not (D.Exists(k)) Then
            GuestyRemoveReservation r
        End If

    Next r
    
End Sub

