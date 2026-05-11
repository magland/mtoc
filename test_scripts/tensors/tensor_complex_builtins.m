% Element-wise lift of complex-aware scalar builtins onto complex tensors.

z = [1+2i 3-4i 0+1i 5+0i];

% sqrt propagates complexity
sz = sqrt(z);
disp(sz);

% abs of a complex tensor produces a REAL tensor (cabs path)
az = abs(z);
disp(az);

% conj of a complex tensor stays complex
cz = conj(z);
disp(cz);

% real / imag extract real components
rz = real(z);
disp(rz);
iz = imag(z);
disp(iz);

% angle is real-valued
gz = angle(z);
disp(gz);

% sign on a complex tensor
sg = sign(z);
disp(sg);
