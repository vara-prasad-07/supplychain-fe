import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const BASE_COLORS = [
  0x3b82f6,
  0x22c55e,
  0xf59e0b,
  0xef4444,
  0x8b5cf6,
  0x06b6d4,
  0xf97316,
  0x10b981,
]

function hashString(value) {
  let hash = 0
  const normalized = String(value || 'item')
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash << 5) - hash + normalized.charCodeAt(index)
    hash |= 0
  }
  return Math.abs(hash)
}

function colorForItem(itemId) {
  return BASE_COLORS[hashString(itemId) % BASE_COLORS.length]
}

export default function Packing3DView({ truckDimensions, positions, height = 340 }) {
  const mountRef = useRef(null)

  useEffect(() => {
    const host = mountRef.current
    if (!host) {
      return undefined
    }

    const width = Math.max(host.clientWidth, 280)
    const viewportHeight = Math.max(height, 260)
    const scale = 0.02

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x08101f)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(width, viewportHeight)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    host.appendChild(renderer.domElement)

    const camera = new THREE.PerspectiveCamera(42, width / viewportHeight, 0.1, 4000)
    const truckLength = Math.max(1, Number(truckDimensions?.l || 0)) * scale
    const truckWidth = Math.max(1, Number(truckDimensions?.w || 0)) * scale
    const truckHeight = Math.max(1, Number(truckDimensions?.h || 0)) * scale

    camera.position.set(truckLength * 1.6, truckHeight * 1.3, truckWidth * 1.6)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.maxDistance = Math.max(truckLength, truckWidth, truckHeight) * 4
    controls.minDistance = 4
    controls.target.set(truckLength / 2, truckHeight / 2, truckWidth / 2)
    controls.enablePan = true
    controls.enableZoom = true
    controls.enableRotate = true
    controls.minPolarAngle = 0
    controls.maxPolarAngle = Math.PI
    controls.minAzimuthAngle = -Infinity
    controls.maxAzimuthAngle = Infinity

    const ambient = new THREE.AmbientLight(0xffffff, 0.55)
    scene.add(ambient)

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.8)
    keyLight.position.set(truckLength * 1.8, truckWidth * 1.2, truckHeight * 2)
    keyLight.castShadow = true
    scene.add(keyLight)

    const fillLight = new THREE.DirectionalLight(0x87a7ff, 0.45)
    fillLight.position.set(-truckLength, -truckWidth, truckHeight)
    scene.add(fillLight)

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(truckLength * 2.5, truckWidth * 2.5),
      new THREE.MeshStandardMaterial({ color: 0x0d1728, roughness: 1 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.position.set(truckLength / 2, -0.03, truckWidth / 2)
    floor.receiveShadow = true
    scene.add(floor)

    const grid = new THREE.GridHelper(truckLength * 2.2, 24, 0x284364, 0x1c2f47)
    grid.position.set(truckLength / 2, 0, truckWidth / 2)
    scene.add(grid)

    const containerGeometry = new THREE.BoxGeometry(truckLength, truckHeight, truckWidth)
    const containerMaterial = new THREE.MeshStandardMaterial({
      color: 0x88aaff,
      transparent: true,
      opacity: 0.11,
      roughness: 0.9,
      metalness: 0.1,
      depthWrite: false,
    })
    const containerMesh = new THREE.Mesh(containerGeometry, containerMaterial)
    containerMesh.position.set(truckLength / 2, truckHeight / 2, truckWidth / 2)
    scene.add(containerMesh)

    const edges = new THREE.EdgesGeometry(containerGeometry)
    const edgeLines = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({ color: 0x7fa3ff, transparent: true, opacity: 0.75 }),
    )
    edgeLines.position.copy(containerMesh.position)
    scene.add(edgeLines)

    const parsedPositions = Array.isArray(positions) ? positions : []
    parsedPositions.forEach((item) => {
      const itemLength = Math.max(1, Number(item.length || 0)) * scale
      const itemWidth = Math.max(1, Number(item.width || 0)) * scale
      const itemHeight = Math.max(1, Number(item.height || 0)) * scale

      const geometry = new THREE.BoxGeometry(itemLength, itemHeight, itemWidth)
      const material = new THREE.MeshStandardMaterial({
        color: colorForItem(item.item_id),
        roughness: 0.38,
        metalness: 0.2,
      })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.position.set(
        (Number(item.x || 0) + Number(item.length || 0) / 2) * scale,
        (Number(item.z || 0) + Number(item.height || 0) / 2) * scale,
        (Number(item.y || 0) + Number(item.width || 0) / 2) * scale,
      )
      scene.add(mesh)

      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({ color: 0xe5efff, transparent: true, opacity: 0.5 }),
      )
      outline.position.copy(mesh.position)
      scene.add(outline)
    })

    let frameId = 0
    const animate = () => {
      controls.update()
      renderer.render(scene, camera)
      frameId = window.requestAnimationFrame(animate)
    }
    animate()

    const resizeObserver = new ResizeObserver(() => {
      if (!mountRef.current) {
        return
      }
      const nextWidth = Math.max(mountRef.current.clientWidth, 280)
      renderer.setSize(nextWidth, viewportHeight)
      camera.aspect = nextWidth / viewportHeight
      camera.updateProjectionMatrix()
    })
    resizeObserver.observe(host)

    return () => {
      window.cancelAnimationFrame(frameId)
      resizeObserver.disconnect()
      controls.dispose()
      renderer.dispose()
      scene.traverse((node) => {
        if (node instanceof THREE.Mesh) {
          node.geometry.dispose()
          if (Array.isArray(node.material)) {
            node.material.forEach((material) => material.dispose())
          } else {
            node.material.dispose()
          }
        }
      })
      host.removeChild(renderer.domElement)
    }
  }, [height, positions, truckDimensions])

  return (
    <div
      ref={mountRef}
      style={{
        width: '100%',
        height: `${height}px`,
        borderRadius: '12px',
        overflow: 'hidden',
        border: '1px solid var(--border-light)',
      }}
    />
  )
}
