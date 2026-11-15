import UIKit
import MapKit

/// Native street map; route coordinates stay in memory and are drawn as an overlay.
@MainActor
final class RouteMapController: UIViewController, MKMapViewDelegate {
    private let map = MKMapView()
    private let live: Bool
    private var points: [CLLocationCoordinate2D]
    private var lastLocation: CLLocation?

    init(points: [CLLocationCoordinate2D], live: Bool) {
        self.points = points
        self.live = live
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { nil }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = live ? "Live GPS map" : "Recorded route"
        view = map
        map.delegate = self
        map.showsCompass = true
        map.showsScale = true
        map.showsUserLocation = live
        navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(closeMap))
        if live {
            let authorization = CLLocationManager().authorizationStatus
            navigationItem.prompt = authorization == .denied || authorization == .restricted
                ? "Enable location access in iPhone Settings" : "Waiting for a fresh GPS position"
            navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Follow", style: .plain, target: self, action: #selector(follow))
            follow()
        }
        redrawRoute()
        if !live, let first = points.first {
            if points.count > 1, let overlay = map.overlays.first {
                map.setVisibleMapRect(overlay.boundingMapRect, edgePadding: UIEdgeInsets(top: 70, left: 40, bottom: 70, right: 40), animated: false)
            } else {
                map.setRegion(MKCoordinateRegion(center: first, latitudinalMeters: 600, longitudinalMeters: 600), animated: false)
            }
        }
    }
    @objc private func closeMap() { dismiss(animated: true) }
    @objc private func follow() { map.setUserTrackingMode(.follow, animated: true) }

    private func redrawRoute() {
        map.removeOverlays(map.overlays)
        if points.count > 1 { map.addOverlay(MKPolyline(coordinates: points, count: points.count)) }
    }
    func mapView(_ mapView: MKMapView, didUpdate userLocation: MKUserLocation) {
        guard live, let location = userLocation.location,
              location.horizontalAccuracy >= 0, location.horizontalAccuracy <= 50,
              abs(location.timestamp.timeIntervalSinceNow) < 5 else { return }
        if let lastLocation, location.timestamp.timeIntervalSince(lastLocation.timestamp) < 1 || location.distance(from: lastLocation) < 3 { return }
        lastLocation = location
        navigationItem.prompt = "GPS accuracy ±\(Int(location.horizontalAccuracy)) m"
        points.append(location.coordinate)
        if points.count > 3600 { points = points.enumerated().filter { $0.offset.isMultiple(of: 2) }.map(\.element) }
        redrawRoute()
    }
    func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
        guard let line = overlay as? MKPolyline else { return MKOverlayRenderer(overlay: overlay) }
        let renderer = MKPolylineRenderer(polyline: line)
        renderer.strokeColor = .systemCyan
        renderer.lineWidth = 4
        return renderer
    }
}
