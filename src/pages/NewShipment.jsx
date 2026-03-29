import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Package, Truck, Route, CheckCircle, AlertTriangle, Shield, MapPin, Clock, DollarSign, Zap, Info, PanelRightOpen, PanelRightClose, Maximize2, Minimize2 } from 'lucide-react'
import { ApiError, previewLogistics, runPackaging, runPipeline } from '../lib/api'
import Packing3DView from '../components/Packing3DView'
import WorkflowFlowchart from '../components/WorkflowFlowchart'
import { upsertShipmentRun } from '../lib/shipmentStore'
import '../styles/NewShipment.css'

const STEPS = [
  { id: 1, label: 'Cargo Specifications' },
  { id: 2, label: 'Vehicle Configuration' },
  { id: 3, label: 'Route & Compliance' },
  { id: 4, label: 'Final Review' }
]
const STEP_CONTINUE_LABELS = {
  1: 'Continue to 3D Fitting',
  2: 'Continue to Route & Compliance',
  3: 'Continue to Final Review',
}

const CARGO_TYPES = ['Electronics', 'Pharmaceuticals', 'Perishables', 'Hazardous Materials', 'General Cargo']
const VEHICLE_CATEGORIES = ['Heavy', 'Mid', 'Light']
const ALGORITHM_LABELS = {
  guillotine_heuristic: 'Guillotine Heuristic',
  extreme_point_rule: 'Extreme Point Rule',
  deepest_bottom_left: 'Deepest Bottom-Left (DBL)',
}
const VEHICLE_PRESETS = {
  Light: {
    maxWeightKg: 2500,
    capacityCbm: 18,
    dimensionsCm: { l: 420, w: 220, h: 190 },
  },
  Mid: {
    maxWeightKg: 7000,
    capacityCbm: 38,
    dimensionsCm: { l: 620, w: 245, h: 250 },
  },
  Heavy: {
    maxWeightKg: 18000,
    capacityCbm: 72,
    dimensionsCm: { l: 1200, w: 250, h: 255 },
  },
}
const CARGO_DENSITY_KG_PER_M3 = {
  Electronics: 320,
  Pharmaceuticals: 420,
  Perishables: 520,
  'Hazardous Materials': 760,
  'General Cargo': 480,
}

function toPositiveNumber(value, fallback) {
  const numeric = Number(value)
  if (Number.isNaN(numeric) || numeric <= 0) {
    return fallback
  }
  return numeric
}

function validateShipmentForm(formData) {
  if (!formData.cargoType) return 'Select a cargo type before dispatch.'
  if (!formData.origin || !formData.destination) return 'Origin and destination are required.'
  if (toPositiveNumber(formData.quantity, 0) <= 0) return 'Quantity must be greater than 0.'
  if (toPositiveNumber(formData.weight, 0) <= 0) return 'Weight must be greater than 0.'
  return ''
}

function validateStepTransition(step, formData, packingPreview, isPreviewLoading, previewError) {
  if (step === 1) {
    if (!formData.cargoType) return 'Select a cargo type to continue.'
    if (toPositiveNumber(formData.quantity, 0) <= 0) return 'Enter quantity to continue.'
    if (toPositiveNumber(formData.weight, 0) <= 0) return 'Enter total weight to continue.'
  }

  if (step === 2) {
    if (isPreviewLoading) return 'Wait for 3D analysis to finish before continuing.'
    if (previewError) return 'Resolve the 3D analysis issue or rerun Analyze before continuing.'
    if (!packingPreview) return 'Run Analyze in 3D Fitting before continuing.'
  }

  if (step === 3) {
    if (!formData.origin) return 'Enter an origin to continue.'
    if (!formData.destination) return 'Enter a destination to continue.'
  }

  return ''
}

function inferUnitVolumeM3(formData, unitWeightKg) {
  const material = String(formData.materialPreference || '').toLowerCase()
  let density = CARGO_DENSITY_KG_PER_M3[formData.cargoType] || CARGO_DENSITY_KG_PER_M3['General Cargo']

  if (material.includes('glass') || material.includes('ceramic')) {
    density = Math.max(density, 900)
  }
  if (material.includes('metal') || material.includes('steel') || material.includes('iron')) {
    density = Math.max(density, 1300)
  }
  if (material.includes('wood') || material.includes('timber')) {
    density = Math.max(density, 680)
  }
  if (material.includes('foam') || material.includes('cotton')) {
    density = Math.max(150, Math.min(density, 300))
  }
  if (formData.hazardous) {
    density *= 1.08
  }

  const rawVolume = unitWeightKg / Math.max(150, density)
  return Math.min(0.09, Math.max(0.0012, rawVolume))
}

function estimateShipmentMetrics(formData) {
  const totalWeightKg = toPositiveNumber(formData.weight, 1)
  const quantity = Math.max(1, Math.round(toPositiveNumber(formData.quantity, 1)))
  const normalizedItemCount = Math.min(quantity, 20)
  const unitWeightKg = Math.max(0.1, totalWeightKg / normalizedItemCount)
  const unitVolumeM3 = inferUnitVolumeM3(formData, unitWeightKg)
  const totalVolumeM3 = unitVolumeM3 * normalizedItemCount
  return {
    totalWeightKg,
    normalizedItemCount,
    unitWeightKg,
    unitVolumeM3,
    totalVolumeM3,
  }
}

function buildGoodsAndVehicles(formData) {
  const { totalWeightKg, normalizedItemCount, unitWeightKg, unitVolumeM3 } = estimateShipmentMetrics(formData)
  const cubeSideCm = Math.max(5, Math.cbrt(unitVolumeM3 * 1_000_000))

  const goods = Array.from({ length: normalizedItemCount }, (_, index) => ({
    item_id: `item_${index + 1}`,
    goods_type: formData.materialPreference
      ? `${formData.cargoType} | material:${formData.materialPreference}`
      : formData.cargoType,
    dimensions: {
      l: Number(cubeSideCm.toFixed(2)),
      w: Number(cubeSideCm.toFixed(2)),
      h: Number(cubeSideCm.toFixed(2)),
    },
    weight_kg: Number(unitWeightKg.toFixed(3)),
    is_fragile: formData.cargoType === 'Electronics' || formData.cargoType === 'Pharmaceuticals',
    is_hazmat: formData.hazardous || formData.cargoType === 'Hazardous Materials',
  }))

  const preset = VEHICLE_PRESETS[formData.vehicleCategory] || VEHICLE_PRESETS.Mid
  const vehicleCount = Math.min(3, Math.max(1, Math.ceil(totalWeightKg / preset.maxWeightKg)))
  const vehicles = Array.from({ length: vehicleCount }, (_, index) => ({
    vehicle_id: `vehicle_${index + 1}`,
    max_weight_kg: preset.maxWeightKg,
    capacity_cbm: preset.capacityCbm,
    vehicle_type: formData.vehicleCategory.toLowerCase(),
    cargo_dimensions_cm: preset.dimensionsCm,
  }))

  return { goods, vehicles }
}

function buildShipmentPayload(formData) {
  const { goods, vehicles } = buildGoodsAndVehicles(formData)
  const routeEfficiency = formData.priority === 'Express' ? 0.86 : 0.78
  const weatherScore = Math.max(0.3, Math.min(0.98, routeEfficiency - 0.04))
  const roadSafetyScore = Math.max(
    0.3,
    Math.min(0.98, formData.hazardous ? routeEfficiency - 0.12 : routeEfficiency),
  )
  const waypoints = []

  return {
    goods,
    vehicles,
    route: {
      origin: formData.origin,
      destination: formData.destination,
      waypoints,
    },
    weather_score: Number(weatherScore.toFixed(2)),
    road_safety_score: Number(roadSafetyScore.toFixed(2)),
  }
}

function buildLogisticsPreviewPayload(formData) {
  const { goods, vehicles } = buildGoodsAndVehicles(formData)
  const complianceFlags = formData.hazardous ? ['hazmat_present'] : []

  return {
    goods,
    vehicles,
    compliance_flags: complianceFlags,
  }
}

function buildPackagingPreviewPayload(formData) {
  const { goods } = buildGoodsAndVehicles(formData)
  const complianceFlags = formData.hazardous ? ['hazmat_present'] : []
  if (formData.materialPreference) {
    complianceFlags.push(`material_preference:${formData.materialPreference}`)
  }

  return {
    goods,
    compliance_results: [],
    compliance_flags: complianceFlags,
  }
}

export default function NewShipment() {
  const navigate = useNavigate()
  const [currentStep, setCurrentStep] = useState(1)
  const [isProcessing, setIsProcessing] = useState(false)
  const [dispatchError, setDispatchError] = useState('')
  const [dispatchRunId, setDispatchRunId] = useState('')
  const [packingPreview, setPackingPreview] = useState(null)
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [packagingPreview, setPackagingPreview] = useState(null)
  const [isPackagingLoading, setIsPackagingLoading] = useState(false)
  const [packagingError, setPackagingError] = useState('')
  const [stepNavigationError, setStepNavigationError] = useState('')
  
  const [formData, setFormData] = useState({
    cargoType: '',
    materialPreference: '',
    quantity: '',
    weight: '',
    value: '',
    hazardous: false,
    vehicleCategory: 'Mid',
    origin: '',
    destination: '',
    priority: 'Standard',
    selectedAlgorithm: '',
  })

  const handleInputChange = (field, value) => {
    const shouldResetPreview = ['cargoType', 'materialPreference', 'quantity', 'weight', 'hazardous', 'vehicleCategory'].includes(field)
    const shouldResetPackaging = ['cargoType', 'materialPreference', 'quantity', 'weight', 'hazardous'].includes(field)
    setStepNavigationError('')
    setFormData(prev => ({
      ...prev,
      [field]: value,
      ...(shouldResetPreview ? { selectedAlgorithm: '' } : {}),
    }))
    if (shouldResetPreview) {
      setPackingPreview(null)
      setPreviewError('')
    }
    if (shouldResetPackaging) {
      setPackagingPreview(null)
      setPackagingError('')
    }
  }

  const handleNext = () => {
    const validationError = validateStepTransition(
      currentStep,
      formData,
      packingPreview,
      isPreviewLoading,
      previewError,
    )
    if (validationError) {
      setStepNavigationError(validationError)
      return
    }

    if (currentStep < 4) {
      setStepNavigationError('')
      setCurrentStep(currentStep + 1)
    }
  }

  const handleBack = () => {
    if (currentStep > 1) {
      setStepNavigationError('')
      setCurrentStep(currentStep - 1)
    }
  }

  const handleGeneratePackingPreview = useCallback(async () => {
    if (!formData.cargoType) {
      setPreviewError('Select cargo type before running 3D analysis.')
      return
    }
    if (toPositiveNumber(formData.quantity, 0) <= 0) {
      setPreviewError('Enter quantity before running 3D analysis.')
      return
    }
    if (toPositiveNumber(formData.weight, 0) <= 0) {
      setPreviewError('Weight must be greater than 0 for 3D packing.')
      return
    }

    setPreviewError('')
    setIsPreviewLoading(true)
    try {
      const previewPayload = buildLogisticsPreviewPayload(formData)
      const previewResponse = await previewLogistics(previewPayload)
      const primaryVehicle = previewResponse?.vehicles?.[0] || null

      if (!primaryVehicle || !primaryVehicle.algorithm_results?.length) {
        throw new Error('No algorithm preview returned for this truck configuration.')
      }

      const selectedStrategy =
        primaryVehicle.algorithm_results.find(
          (result) => result.strategy === formData.selectedAlgorithm,
        )?.strategy || primaryVehicle.recommended_strategy

      setPackingPreview(primaryVehicle)
      setFormData((prev) => ({ ...prev, selectedAlgorithm: selectedStrategy }))
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'Unable to generate 3D packing preview.')
    } finally {
      setIsPreviewLoading(false)
    }
  }, [formData])

  const handleGeneratePackagingPreview = useCallback(async () => {
    if (!formData.cargoType) {
      setPackagingError('Select cargo type to generate packaging suggestions.')
      return
    }
    if (toPositiveNumber(formData.quantity, 0) <= 0) {
      setPackagingError('Enter quantity to generate packaging suggestions.')
      return
    }
    if (toPositiveNumber(formData.weight, 0) <= 0) {
      setPackagingError('Weight must be greater than 0 for packaging suggestions.')
      return
    }

    setPackagingError('')
    setIsPackagingLoading(true)
    try {
      const payload = buildPackagingPreviewPayload(formData)
      const response = await runPackaging(payload)
      setPackagingPreview(response)
    } catch (error) {
      setPackagingError(error instanceof Error ? error.message : 'Unable to generate packaging suggestions.')
    } finally {
      setIsPackagingLoading(false)
    }
  }, [formData])

  useEffect(() => {
    if (currentStep !== 2) {
      return
    }
    if (packingPreview || isPreviewLoading || previewError) {
      return
    }
    if (!formData.cargoType) {
      return
    }
    if (toPositiveNumber(formData.quantity, 0) <= 0) {
      return
    }
    if (toPositiveNumber(formData.weight, 0) <= 0) {
      return
    }

    handleGeneratePackingPreview()
  }, [
    currentStep,
    packingPreview,
    isPreviewLoading,
    previewError,
    formData.cargoType,
    formData.materialPreference,
    formData.quantity,
    formData.weight,
    formData.hazardous,
    formData.vehicleCategory,
    handleGeneratePackingPreview,
  ])

  useEffect(() => {
    if (currentStep !== 1) {
      return
    }
    if (packagingPreview || isPackagingLoading || packagingError) {
      return
    }
    if (!formData.cargoType) {
      return
    }
    if (toPositiveNumber(formData.quantity, 0) <= 0) {
      return
    }
    if (toPositiveNumber(formData.weight, 0) <= 0) {
      return
    }
    handleGeneratePackagingPreview()
  }, [
    currentStep,
    packagingPreview,
    isPackagingLoading,
    packagingError,
    formData.cargoType,
    formData.materialPreference,
    formData.quantity,
    formData.weight,
    formData.hazardous,
    handleGeneratePackagingPreview,
  ])

  const handleDispatch = async () => {
    if (!packingPreview) {
      setDispatchError('Run 3D Analyze in Step 2 to generate the final box placement first.')
      return
    }

    const validationError = validateShipmentForm(formData)
    if (validationError) {
      setDispatchError(validationError)
      return
    }

    setDispatchError('')
    setIsProcessing(true)
    const requestPayload = buildShipmentPayload(formData)

    try {
      const { runId, result } = await runPipeline(requestPayload)
      const resolvedRunId =
        runId ||
        (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `run-${Date.now()}`)

      setDispatchRunId(resolvedRunId)
      upsertShipmentRun({
        runId: resolvedRunId,
        createdAt: new Date().toISOString(),
        origin: formData.origin,
        destination: formData.destination,
        cargoType: formData.cargoType,
        quantity: Number(formData.quantity) || 1,
        declaredValueUsd: toPositiveNumber(formData.value, 0),
        priority: formData.priority,
        selectedRouteName: `${formData.origin} -> ${formData.destination}`,
        selectedAlgorithm: formData.selectedAlgorithm || packingPreview.recommended_strategy,
        packagingPreview,
        packingPreview,
        requestPayload,
        pipelineResult: result,
        pipelineStatus: result?.pipeline_status || 'SUCCESS',
      })

      navigate('/live-ops', { state: { runId: resolvedRunId } })
    } catch (error) {
      if (error instanceof ApiError && error.payload?.run_id && error.payload?.pipeline_result) {
        upsertShipmentRun({
          runId: error.payload.run_id,
          createdAt: new Date().toISOString(),
          origin: formData.origin,
          destination: formData.destination,
          cargoType: formData.cargoType,
          quantity: Number(formData.quantity) || 1,
          declaredValueUsd: toPositiveNumber(formData.value, 0),
          priority: formData.priority,
          selectedRouteName: `${formData.origin} -> ${formData.destination}`,
          selectedAlgorithm: formData.selectedAlgorithm || packingPreview.recommended_strategy,
          packagingPreview,
          packingPreview,
          requestPayload,
          pipelineResult: error.payload.pipeline_result,
          pipelineStatus: error.payload.pipeline_result.pipeline_status || 'FAILED',
        })
      }

      setDispatchError(error instanceof Error ? error.message : 'Unable to dispatch shipment.')
      setIsProcessing(false)
    }
  }

  return (
    <div className="new-shipment-page">
      <WorkflowFlowchart 
        currentStep={currentStep === 2 ? '3d-fitting' : 'packaging'} 
        runId={null}
        onStepChange={setCurrentStep}
        currentStepNumber={currentStep}
      />
      
      {currentStep !== 2 && (
        <>
          <div className="page-header">
            <div className="page-header-left">
              <h1>Create New Shipment</h1>
              <p>Configure and dispatch intelligent logistics operations</p>
            </div>
          </div>

          <div className="stepper">
            {STEPS.map((step) => (
              <div 
                key={step.id} 
                className={`stepper-item ${currentStep === step.id ? 'active' : ''} ${currentStep > step.id ? 'completed' : ''}`}
              >
                <div className="stepper-number">
                  {currentStep > step.id ? <CheckCircle size={16} /> : step.id}
                </div>
                <span className="stepper-label">{step.label}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {!isProcessing ? (
        <div className="shipment-form-container">
          {currentStep === 1 && (
            <Step1
              formData={formData}
              onChange={handleInputChange}
              packagingPreview={packagingPreview}
              isPackagingLoading={isPackagingLoading}
              packagingError={packagingError}
              onGeneratePackaging={handleGeneratePackagingPreview}
            />
          )}
          {currentStep === 2 && (
            <Step2
              formData={formData}
              onChange={handleInputChange}
              packingPreview={packingPreview}
              isPreviewLoading={isPreviewLoading}
              previewError={previewError}
              onGeneratePreview={handleGeneratePackingPreview}
            />
          )}
          {currentStep === 3 && <Step3 formData={formData} onChange={handleInputChange} />}
          {currentStep === 4 && (
            <Step4
              formData={formData}
              onDispatch={handleDispatch}
              dispatchError={dispatchError}
              packingPreview={packingPreview}
              packagingPreview={packagingPreview}
            />
          )}

          <div className="form-actions">
            {stepNavigationError ? (
              <div className="form-actions-message" role="alert">
                {stepNavigationError}
              </div>
            ) : (
              <div />
            )}
            <div className="form-actions-buttons">
              {currentStep > 1 && (
                <button className="btn btn-secondary" onClick={handleBack}>
                  Back
                </button>
              )}
              {currentStep < 4 && (
                <button className="btn btn-primary" onClick={handleNext}>
                  {STEP_CONTINUE_LABELS[currentStep] || 'Continue'}
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <ExecutionPipeline runId={dispatchRunId} />
      )}
    </div>
  )
}

function Step1({
  formData,
  onChange,
  packagingPreview,
  isPackagingLoading,
  packagingError,
  onGeneratePackaging,
}) {
  const estimated = estimateShipmentMetrics(formData)
  const previewItems = packagingPreview?.items || []
  const topItem = previewItems[0] || null
  const topMaterials = topItem?.recommended_materials?.slice(0, 6) || []
  const allMaterials = [...new Set(previewItems.flatMap((item) => item.recommended_materials || []))]
  const totalPackagingCost = Number(packagingPreview?.total_cost_usd || 0)
  const perUnitPackagingCost = estimated.normalizedItemCount
    ? totalPackagingCost / estimated.normalizedItemCount
    : 0

  return (
    <div className="step-content">
      <div className="step-main">
        <div className="step-header">
          <div className="step-badge">STEP 1 OF 4</div>
          <h2>Cargo Specifications</h2>
          <p className="step-description">
            Provide technical details for the inventory batch. These parameters directly influence AI route optimization and risk scoring.
          </p>
        </div>
        
        <div className="form-section">
          <div className="form-group">
            <label className="form-label">Cargo Type</label>
            <select 
              className="form-select" 
              value={formData.cargoType}
              onChange={(e) => onChange('cargoType', e.target.value)}
            >
              <option value="">Select cargo type</option>
              {CARGO_TYPES.map(type => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label className="form-label">Goods Material (Optional)</label>
            <input
              type="text"
              className="form-input"
              placeholder="e.g. glass, metal, wood, plastic"
              value={formData.materialPreference}
              onChange={(e) => onChange('materialPreference', e.target.value)}
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Quantity (Units)</label>
              <input 
                type="number" 
                className="form-input" 
                placeholder="0"
                value={formData.quantity}
                onChange={(e) => onChange('quantity', e.target.value)}
              />
            </div>

            <div className="form-group">
              <label className="form-label">Total Weight (kg)</label>
              <input 
                type="number" 
                className="form-input" 
                placeholder="0.00"
                step="0.01"
                value={formData.weight}
                onChange={(e) => onChange('weight', e.target.value)}
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Estimated Volume (Auto)</label>
              <div className="form-input-calculated">
                <span>{estimated.totalVolumeM3.toFixed(3)} m³</span>
                <Info size={16} color="var(--primary-light)" />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Weight Per Unit (Auto)</label>
              <div className="form-input-calculated">
                <span>{estimated.unitWeightKg.toFixed(2)} kg</span>
                <Info size={16} color="var(--primary-light)" />
              </div>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Declared Cargo Value (USD)</label>
            <input 
              type="number" 
              className="form-input" 
              placeholder="$ 0.00"
              value={formData.value}
              onChange={(e) => onChange('value', e.target.value)}
            />
          </div>

          <div className="dangerous-goods-toggle">
            <div className="dangerous-goods-info">
              <AlertTriangle size={20} color="var(--warning)" />
              <div>
                <div className="dangerous-goods-title">Dangerous Goods</div>
                <div className="dangerous-goods-subtitle">Classify as hazardous materials (HAZMAT)</div>
              </div>
            </div>
            <div 
              className={`toggle ${formData.hazardous ? 'active' : ''}`}
              onClick={() => onChange('hazardous', !formData.hazardous)}
            >
              <div className="toggle-knob"></div>
            </div>
          </div>
        </div>

        <div
          className="card"
          style={{
            marginTop: 'var(--space-6)',
            padding: 'var(--space-6)',
            border: '1px solid rgba(59,130,246,0.28)',
            background: 'linear-gradient(180deg, rgba(59,130,246,0.12) 0%, rgba(15,23,42,0.92) 100%)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', gap: '12px', flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ marginBottom: '4px' }}>Packaging Agent Recommendation</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.84rem' }}>
                Material-aware output for this shipment profile. Refresh anytime after changing cargo inputs.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onGeneratePackaging}
              disabled={isPackagingLoading}
            >
              {isPackagingLoading ? 'Analyzing...' : 'Refresh Recommendation'}
            </button>
          </div>

          {packagingError ? (
            <div style={{ padding: '10px 12px', borderRadius: '8px', border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.1)', color: 'var(--error)', fontSize: '0.84rem' }}>
              {packagingError}
            </div>
          ) : null}

          {!packagingError && topItem ? (
            <div style={{ display: 'grid', gap: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '10px' }}>
                <div style={{ padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border-light)', background: 'rgba(2,6,23,0.36)' }}>
                  <div className="label">Total Estimated Cost</div>
                  <div style={{ fontWeight: 700, marginTop: '4px' }}>${totalPackagingCost.toFixed(2)}</div>
                </div>
                <div style={{ padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border-light)', background: 'rgba(2,6,23,0.36)' }}>
                  <div className="label">Per Unit Cost</div>
                  <div style={{ fontWeight: 700, marginTop: '4px' }}>${perUnitPackagingCost.toFixed(2)}</div>
                </div>
                <div style={{ padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--border-light)', background: 'rgba(2,6,23,0.36)' }}>
                  <div className="label">Agent Confidence</div>
                  <div style={{ fontWeight: 700, marginTop: '4px' }}>
                    {Math.round(Number(packagingPreview.agent_confidence || 0) * 100)}%
                  </div>
                </div>
              </div>

              <div style={{ color: 'var(--text-secondary)', fontSize: '0.84rem' }}>
                Primary materials: {topMaterials.length ? topMaterials.join(', ') : 'N/A'}
              </div>

              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {allMaterials.map((material) => (
                  <span key={material} className="badge badge-info" style={{ textTransform: 'none', fontSize: '0.76rem' }}>
                    {material}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {!packagingError && !topItem && !isPackagingLoading ? (
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.84rem' }}>
              Enter cargo type, units, and total weight to generate packaging materials and estimated cost.
            </div>
          ) : null}
        </div>
      </div>

      <div className="step-sidebar">
        <div className="card manifest-card">
          <div className="manifest-header">
            <Package size={18} color="var(--primary-light)" />
            <h3>Manifest Summary</h3>
          </div>

          <div className="manifest-status">
            <div className="label">Session State</div>
            <div className="status-badge">
              <span className="status-indicator"></span>
              <span>Actively Drafting</span>
              <span className="badge badge-info">STEP 1</span>
            </div>
          </div>

          <div className="manifest-metrics">
            <div className="manifest-metric">
              <span className="label">Est. Weight</span>
              <span className="value">{formData.weight || '0.00'} kg</span>
            </div>
            <div className="manifest-metric">
              <span className="label">Est. Volume</span>
              <span className="value">{estimated.totalVolumeM3.toFixed(3)} m³</span>
            </div>
            <div className="manifest-metric">
              <span className="label">Material</span>
              <span className="value">{formData.materialPreference || 'Not provided'}</span>
            </div>
            <div className="manifest-metric">
              <span className="label">Value Risk</span>
              <span className="badge badge-success">Low</span>
            </div>
          </div>

          <div className="ai-insight-box">
            <div className="ai-insight-icon">
              <Zap size={16} color="var(--primary-light)" />
            </div>
            <div className="ai-insight-content">
              <div className="ai-insight-title">AI Insight</div>
              <p className="ai-insight-text">
                {formData.cargoType && formData.weight ? 
                  `Fill in quantity and weight to receive real-time container packing suggestions.` :
                  'Complete cargo details to activate AI recommendations.'
                }
              </p>
            </div>
          </div>

          <div className="required-docs">
            <div className="label">Required Documents</div>
            <div className="docs-checklist">
              <div className="doc-item">
                <input type="checkbox" id="doc1" />
                <label htmlFor="doc1">Commercial Invoice</label>
              </div>
              <div className="doc-item">
                <input type="checkbox" id="doc2" />
                <label htmlFor="doc2">Packing List</label>
              </div>
              <div className="doc-item">
                <input type="checkbox" id="doc3" />
                <label htmlFor="doc3">HAZMAT Declaration</label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Step2({
  formData,
  onChange,
  packingPreview,
  isPreviewLoading,
  previewError,
  onGeneratePreview,
}) {
  const estimated = estimateShipmentMetrics(formData)
  const algorithmResults = packingPreview?.algorithm_results || []
  const selectedResult =
    algorithmResults.find((result) => result.strategy === formData.selectedAlgorithm) ||
    algorithmResults[0] ||
    null
  const selectedStrategy = selectedResult?.strategy || packingPreview?.recommended_strategy || ''
  const truckDimensions =
    packingPreview?.cargo_dimensions_cm ||
    (VEHICLE_PRESETS[formData.vehicleCategory]?.dimensionsCm || VEHICLE_PRESETS.Mid.dimensionsCm)
  const packedCount = selectedResult?.packed_items?.length || 0
  const unpackedCount = selectedResult?.unpacked_items?.length || 0
  const spaceUtil = selectedResult?.space_utilization_pct || 0
  const weightUtil = selectedResult?.weight_utilization_pct || 0
  const [isViewerFullscreen, setIsViewerFullscreen] = useState(false)
  const [viewerHeight, setViewerHeight] = useState(560)

  useEffect(() => {
    const updateViewerHeight = () => {
      if (typeof window === 'undefined') {
        setViewerHeight(560)
        return
      }

      const nextHeight = isViewerFullscreen ? Math.max(460, window.innerHeight - 120) : 560
      setViewerHeight(nextHeight)
    }

    updateViewerHeight()
    window.addEventListener('resize', updateViewerHeight)
    return () => {
      window.removeEventListener('resize', updateViewerHeight)
    }
  }, [isViewerFullscreen])

  useEffect(() => {
    if (!isViewerFullscreen) {
      return undefined
    }

    const previousOverflow = document.body.style.overflow
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setIsViewerFullscreen(false)
      }
    }

    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [isViewerFullscreen])

  const toggleViewerFullscreen = () => {
    setIsViewerFullscreen((current) => !current)
  }

  return (
    <div className="step-content-fullscreen">
      <div className="canvas-main-area">
        <div className="canvas-header">
          <div className="canvas-header-actions">
            <div className="vehicle-tabs-compact">
              {VEHICLE_CATEGORIES.map(category => (
                <button
                  key={category}
                  className={`vehicle-tab ${formData.vehicleCategory === category ? 'active' : ''}`}
                  onClick={() => onChange('vehicleCategory', category)}
                >
                  <Truck size={18} />
                  <span>{category}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Fullscreen 3D Viewport */}
        <div className={`viewport-3d-fullscreen ${isViewerFullscreen ? 'is-maximized' : ''}`}>
          <button
            className="viewport-expand-btn"
            type="button"
            onClick={toggleViewerFullscreen}
            aria-pressed={isViewerFullscreen}
            aria-label={isViewerFullscreen ? 'Minimize 3D viewport' : 'Maximize 3D viewport'}
          >
            {isViewerFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            <span>{isViewerFullscreen ? 'Minimize' : 'Maximize'}</span>
          </button>
          <Packing3DView
            truckDimensions={truckDimensions}
            positions={selectedResult?.positions || []}
            height={viewerHeight}
          />
          {!selectedResult && !isPreviewLoading ? (
            <div
              style={{
                position: 'absolute',
                top: '18px',
                right: '18px',
                zIndex: 4,
                maxWidth: '320px',
                padding: '10px 12px',
                borderRadius: '10px',
                border: '1px solid var(--border-light)',
                background: 'rgba(10,16,28,0.82)',
                color: 'var(--text-secondary)',
                fontSize: '0.78rem',
              }}
            >
              Fill cargo details (quantity and weight) then run Analyze to generate real box placements.
            </div>
          ) : null}
          {selectedResult && selectedResult.positions.length === 0 ? (
            <div
              style={{
                position: 'absolute',
                top: '18px',
                right: '18px',
                zIndex: 4,
                maxWidth: '320px',
                padding: '10px 12px',
                borderRadius: '10px',
                border: '1px solid rgba(245,158,11,0.35)',
                background: 'rgba(245,158,11,0.12)',
                color: 'var(--warning)',
                fontSize: '0.78rem',
              }}
            >
              No boxes fit with current dimensions. Reduce per-item size or choose a larger vehicle.
            </div>
          ) : null}
          
          <div className="viewport-overlays">
            <div className="viewport-overlay-card">
              <div className="label">Space Utilization</div>
              <div className="overlay-value">{spaceUtil.toFixed(1)}%</div>
              <div className="progress-bar-wrapper">
                <div className="progress-bar-fill" style={{ width: `${Math.min(spaceUtil, 100)}%`, background: 'var(--success)' }}></div>
              </div>
            </div>
            
            <div className="viewport-overlay-card">
              <div className="label">Weight Utilization</div>
              <div className="overlay-value">{weightUtil.toFixed(1)}%</div>
            </div>
            
            <div className="viewport-overlay-card">
              <div className="label">Strategy</div>
              <div className="overlay-value" style={{ fontSize: '0.72rem' }}>
                {selectedStrategy ? ALGORITHM_LABELS[selectedStrategy] : 'Run Analyze'}
              </div>
            </div>
          </div>

          <div className="viewport-controls">
            <button className="viewport-control-btn" type="button">
              <Package size={14} />
              <span>Drag to Orbit</span>
            </button>
            <button className="viewport-control-btn" type="button" onClick={toggleViewerFullscreen}>
              {isViewerFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              <span>{isViewerFullscreen ? 'Minimize' : 'Fullscreen'}</span>
            </button>
            <button
              className="viewport-control-btn"
              type="button"
              onClick={onGeneratePreview}
              disabled={isPreviewLoading}
            >
              <Zap size={14} />
              <span>{isPreviewLoading ? 'Analyzing...' : 'Analyze'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Step3({ formData, onChange }) {
  return (
    <div className="step-content">
      <div className="step-main">
        <h2>Route & Compliance</h2>
        
        <div className="form-grid">
          <div className="form-group">
            <label className="form-label">Origin Node</label>
            <input 
              type="text" 
              className="form-input" 
              placeholder="Enter origin"
              value={formData.origin}
              onChange={(e) => onChange('origin', e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Destination Node</label>
            <input 
              type="text" 
              className="form-input" 
              placeholder="Enter destination"
              value={formData.destination}
              onChange={(e) => onChange('destination', e.target.value)}
            />
          </div>

          <div className="form-group">
            <label className="form-label">Transit Priority</label>
            <select 
              className="form-select"
              value={formData.priority}
              onChange={(e) => onChange('priority', e.target.value)}
            >
              <option value="Standard">Standard</option>
              <option value="Express">Express</option>
            </select>
          </div>
        </div>

        <div className="routes-section">
          <h3>Route Agent Planning</h3>
          <div className="card" style={{ padding: 'var(--space-5)' }}>
            <div style={{ display: 'grid', gap: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--text-primary)' }}>
                <MapPin size={16} color="var(--primary-light)" />
                <span>{formData.origin || 'Origin'} → {formData.destination || 'Destination'}</span>
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                On dispatch, the Route Agent evaluates multiple compliant paths with live map signals and selects the best-scoring route.
              </p>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <span className="badge badge-info">Priority: {formData.priority}</span>
                <span className={`badge ${formData.hazardous ? 'badge-warning' : 'badge-success'}`}>
                  Hazmat: {formData.hazardous ? 'Yes' : 'No'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="step-sidebar">
        <div className="card">
          <h3 className="card-title">Compliance Guardrails</h3>
          <div className="compliance-list">
            <div className="compliance-item success">
              <CheckCircle size={16} />
              <span>Hazmat Protocol</span>
            </div>
            <div className="compliance-item success">
              <CheckCircle size={16} />
              <span>Weight Limit Validation</span>
            </div>
            <div className="compliance-item success">
              <CheckCircle size={16} />
              <span>Insurance Check</span>
            </div>
            <div className="compliance-item success">
              <CheckCircle size={16} />
              <span>Restricted Zones</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Step4({ formData, onDispatch, dispatchError, packingPreview, packagingPreview }) {
  const algorithmResults = packingPreview?.algorithm_results || []
  const selectedResult =
    algorithmResults.find((result) => result.strategy === formData.selectedAlgorithm) ||
    algorithmResults[0] ||
    null
  const selectedStrategy = selectedResult?.strategy || packingPreview?.recommended_strategy || ''
  const confidenceScore = selectedResult ? selectedResult.space_utilization_pct.toFixed(1) : '0.0'
  const packagingItems = packagingPreview?.items || []
  const packagingTop = packagingItems[0] || null
  const weatherRisk = formData.priority === 'Express' ? 'Medium' : 'Low'
  const congestionRisk = formData.priority === 'Express' ? 'Medium' : 'Low'
  const maintenanceRisk = formData.hazardous ? 'Medium' : 'Low'
  const badgeForRisk = (risk) => (risk === 'High' ? 'badge-error' : risk === 'Medium' ? 'badge-warning' : 'badge-success')

  return (
    <div className="step-content">
      <div className="step-main">
        <h2>Final Review</h2>
        <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
            <MapPin size={18} color="var(--primary-light)" />
            <strong>{formData.origin || 'Origin'} → {formData.destination || 'Destination'}</strong>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
            Route alternatives and the best path are selected by the Route Agent in Live Ops after dispatch.
          </p>
        </div>

        <div className="summary-grid">
          <div className="summary-card">
            <Clock size={20} color="#3b82f6" />
            <div>
              <div className="label">ETA Source</div>
              <div className="summary-value" style={{ fontSize: '0.95rem' }}>Route Agent (Live Ops)</div>
            </div>
          </div>

          <div className="summary-card">
            <DollarSign size={20} color="#22c55e" />
            <div>
              <div className="label">Declared Value</div>
              <div className="summary-value">${Number(formData.value || 0).toLocaleString()}</div>
            </div>
          </div>

          <div className="summary-card">
            <Shield size={20} color="#f59e0b" />
            <div>
              <div className="label">Packing Confidence</div>
              <div className="summary-value">{confidenceScore}%</div>
            </div>
          </div>

          <div className="summary-card">
            <Route size={20} color="#8b5cf6" />
            <div>
              <div className="label">Final Algorithm</div>
              <div className="summary-value">
                {selectedStrategy ? ALGORITHM_LABELS[selectedStrategy] : 'Not generated'}
              </div>
            </div>
          </div>
        </div>

        <div className="risk-indicators">
          <h3>Risk Indicators</h3>
          <div className="risk-grid">
            <div className="risk-item">
              <span>Weather</span>
              <span className={`badge ${badgeForRisk(weatherRisk)}`}>{weatherRisk}</span>
            </div>
            <div className="risk-item">
              <span>Congestion</span>
              <span className={`badge ${badgeForRisk(congestionRisk)}`}>{congestionRisk}</span>
            </div>
            <div className="risk-item">
              <span>Maintenance</span>
              <span className={`badge ${badgeForRisk(maintenanceRisk)}`}>{maintenanceRisk}</span>
            </div>
          </div>
        </div>

        <div className="card" style={{ marginBottom: 'var(--space-6)' }}>
          <h3 style={{ marginBottom: '10px' }}>Packaging Agent Output</h3>
          {packagingTop ? (
            <div style={{ display: 'grid', gap: '8px', fontSize: '0.82rem' }}>
              <div style={{ color: 'var(--text-secondary)' }}>
                Primary materials: {packagingTop.recommended_materials?.slice(0, 4).join(', ') || 'N/A'}
              </div>
              <div style={{ color: 'var(--text-secondary)' }}>
                Estimated total packaging cost: ${Number(packagingPreview.total_cost_usd || 0).toFixed(2)}
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <span className="badge badge-success">Items: {packagingItems.length}</span>
                <span className="badge badge-info">
                  Confidence: {Math.round(Number(packagingPreview.agent_confidence || 0) * 100)}%
                </span>
              </div>
            </div>
          ) : (
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
              Packaging suggestions will be generated from the Packaging Agent when cargo details are complete.
            </div>
          )}
        </div>

        <div style={{ marginBottom: 'var(--space-6)' }}>
          <h3 style={{ marginBottom: '10px' }}>Final Truck Configuration (3D)</h3>
          {selectedResult ? (
            <>
              <Packing3DView
                truckDimensions={packingPreview?.cargo_dimensions_cm}
                positions={selectedResult.positions}
                height={320}
              />
              <div style={{ marginTop: '10px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <span className="badge badge-info">
                  {ALGORITHM_LABELS[selectedStrategy] || selectedStrategy}
                </span>
                <span className="badge badge-success">
                  Packed: {selectedResult.packed_items.length}
                </span>
                <span className={`badge ${selectedResult.unpacked_items.length ? 'badge-warning' : 'badge-success'}`}>
                  Unpacked: {selectedResult.unpacked_items.length}
                </span>
              </div>
            </>
          ) : (
            <div
              style={{
                padding: '14px',
                borderRadius: '8px',
                border: '1px solid var(--border-light)',
                background: 'var(--surface)',
                color: 'var(--text-secondary)',
                fontSize: '0.82rem',
              }}
            >
              Run 3D Analyze in Step 2 to generate the algorithm-based final packing configuration.
            </div>
          )}
        </div>

        <div className="confirmation-section">
          {dispatchError ? (
            <div
              style={{
                marginBottom: '12px',
                padding: '10px 12px',
                borderRadius: '8px',
                border: '1px solid rgba(239,68,68,0.35)',
                background: 'rgba(239,68,68,0.1)',
                color: 'var(--error)',
                fontSize: '0.82rem',
              }}
            >
              {dispatchError}
            </div>
          ) : null}
          <label className="confirmation-checkbox">
            <input type="checkbox" />
            <span>I confirm all details are correct and authorize dispatch</span>
          </label>
          <button className="btn btn-success btn-large" onClick={onDispatch} disabled={!packingPreview}>
            <CheckCircle size={20} />
            Confirm & Dispatch
          </button>
        </div>
      </div>

      <div className="step-sidebar">
        <div className="card">
          <h3 className="card-title">Algorithm Comparison</h3>
          <div className="alt-routes">
            {(algorithmResults.length ? algorithmResults : []).map((result) => (
              <div key={result.strategy} className="alt-route">
                <div className="alt-route-name">{ALGORITHM_LABELS[result.strategy] || result.strategy}</div>
                <div className="alt-route-metrics">
                  <span>{result.space_utilization_pct.toFixed(1)}% space</span>
                  <span>{result.weight_utilization_pct.toFixed(1)}% weight</span>
                  <span className={`badge ${selectedStrategy === result.strategy ? 'badge-success' : 'badge-info'}`}>
                    {selectedStrategy === result.strategy ? 'Selected' : 'Candidate'}
                  </span>
                </div>
              </div>
            ))}
            {!algorithmResults.length ? (
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                No algorithm output yet.
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

function ExecutionPipeline({ runId }) {
  const agents = [
    { name: 'Packaging Agent', status: 'Processing', icon: Package, color: '#3b82f6' },
    { name: 'Logistics Agent', status: 'Optimizing', icon: Truck, color: '#22c55e' },
    { name: 'Route Agent', status: 'Validating', icon: Route, color: '#f59e0b' },
    { name: 'Compliance Agent', status: 'Checking', icon: Shield, color: '#8b5cf6' }
  ]

  return (
    <div className="execution-pipeline">
      <h2>AI Execution Pipeline</h2>
      <p className="pipeline-subtitle">Multi-agent orchestration in progress</p>
      {runId ? (
        <p className="pipeline-subtitle" style={{ marginTop: '4px', color: 'var(--text-muted)' }}>
          Run ID: {runId}
        </p>
      ) : null}
      
      <div className="pipeline">
        {agents.map((agent, index) => (
          <div key={index} className="pipeline-item active">
            <div className="pipeline-icon" style={{ background: `${agent.color}20`, color: agent.color }}>
              <agent.icon size={20} />
            </div>
            <div className="pipeline-info">
              <div className="pipeline-name">{agent.name}</div>
              <div className="pipeline-status">{agent.status}</div>
            </div>
            <div className="pipeline-spinner"></div>
          </div>
        ))}
      </div>
    </div>
  )
}
